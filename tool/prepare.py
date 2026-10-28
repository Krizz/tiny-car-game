"""Compatible game disc (or game folder) -> files for the browser game and its server.

Runs inside the tool image (tool/Dockerfile; start.sh calls it). Python stdlib + 7z + ffmpeg.
  prepare.py <input> [--rebuild] [--no-music]
<input> is any of:
  - an archive (.7z, .zip, .rar — by its contents) holding any of the below: unpacked first
  - a disc image: .cue (+ its .bin), .bin/.img (raw 2352-byte sectors), .iso (2048-byte sectors) — told
    apart by where the ISO 9660 signature sits, not by the name. A .cue next to an .iso/.bin is used
    for the music (the CD audio tracks are only in a raw image).
  - a folder: an installed game, a mounted or copied CD, or a folder holding a disc image.
Output (OUT, default /out): game/ (what the page loads, served at /game/), and .prepared.json. Run again
with the same input and tool version, it does nothing (--rebuild: convert anyway).
"""
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time

TOOL = os.path.dirname(os.path.abspath(__file__))
APP = os.environ.get("APP", "/app")  # the game's code (shared/course.ts) and training files
OUT = os.environ.get("OUT", "/out")
CONVERT = os.path.join(TOOL, "convert.py")
VERSION_FILES = [CONVERT, os.path.abspath(__file__)]

args = [a for a in sys.argv[1:] if not a.startswith("--")]
flags = {a for a in sys.argv[1:] if a.startswith("--")}
if len(args) != 1:
    sys.exit(__doc__)
INPUT = args[0]


def say(*a):
    print(*a, flush=True)


def fail(msg):
    say("error:", msg)
    sys.exit(1)


# ------------------------------------------------------------------ what the game needs

def levels():
    """The 13 race levels, from shared/course.ts (one list for the game and this tool)."""
    src = open(os.path.join(APP, "shared", "course.ts")).read()
    block = re.search(r"LEVEL_IDS\s*=\s*\[(.*?)\]", src, re.S).group(1)
    return re.findall(r"'(\w+)'", block)


def level_names(want, root, search):
    """{folder: the name the game shows}, from the user's own files: the level table in the game's exe
    (each entry: the folder in a 16-byte field, then the name — e.g. ToyLite / Toy World 1), else the
    level's .inf NAME, else the folder."""
    names, exes = {}, []
    for top in search:
        for r, _, fs in os.walk(top):
            exes += [os.path.join(r, f) for f in fs if f.lower().endswith(".exe")]
    for exe in sorted(set(exes), key=lambda p: (os.path.basename(p).lower() != "revolt.exe", p)):
        try:
            b = open(exe, "rb").read()
        except OSError:
            continue
        low = b.lower()
        for l in want:
            if l in names:
                continue
            i = low.find(b"\0" + l.encode() + b"\0")
            while i >= 0:
                start = i + 1
                m = re.match(rb"([\x20-\x7e]{3,40})\0", b[start + 16:start + 60])
                if m and start % 4 == 0:
                    names[l] = m.group(1).decode()
                    break
                i = low.find(b"\0" + l.encode() + b"\0", i + 1)
        if len(names) == len(want):
            break
    found = len(names)
    for l in want:
        if l in names:
            continue
        lv = ci(ci(root, "levels"), l)
        inf = next((os.path.join(lv, f) for f in os.listdir(lv) if f.lower().endswith(".inf")), None) if lv else None
        m = inf and re.search(r"^\s*NAME\s+'([^']+)'", open(inf, encoding="latin-1").read(), re.M | re.I)
        names[l] = m.group(1) if m else l
    return names, found


def ci(path, name):
    """Case-insensitive child of a folder (discs and installs differ: Levels / LEVELS / levels)."""
    try:
        for n in os.listdir(path):
            if n.lower() == name.lower():
                return os.path.join(path, n)
    except (NotADirectoryError, FileNotFoundError, PermissionError):
        pass
    return None


def game_root(top, depth=4):
    """Find the folder holding levels/, cars/ and wavs/ inside a disc or installation."""
    if all(ci(top, d) for d in ("levels", "cars", "wavs")):
        return top
    if depth == 0:
        return None
    try:
        subs = sorted(os.path.join(top, n) for n in os.listdir(top))
    except (NotADirectoryError, PermissionError):
        return None
    for s in subs:
        if os.path.isdir(s) and not os.path.islink(s):
            r = game_root(s, depth - 1)
            if r:
                return r
    return None


ARCHIVES = {b"7z\xbc\xaf\x27\x1c": "7z", b"PK\x03\x04": "zip", b"Rar!\x1a\x07": "rar"}


def archive_kind(path):
    """'7z' / 'zip' / 'rar' by the file's first bytes (not its name), else None."""
    with open(path, "rb") as f:
        head = f.read(8)
    return next((k for sig, k in ARCHIVES.items() if head.startswith(sig)), None)


def seven_zip():
    return shutil.which("7zz") or shutil.which("7z") or "7z"  # Debian's 7zip package calls it 7zz


def walk(top, depth):
    """os.walk, at most `depth` folders down."""
    base = top.rstrip("/").count("/")
    for r, ds, fs in os.walk(top):
        if r.count("/") - base >= depth:
            ds[:] = []
        ds.sort()
        yield r, ds, sorted(fs)


# ------------------------------------------------------------------ disc images

def sector_layout(path):
    """(sector size, data offset in a sector) of an image, from where 'CD001' is; None = not a data image."""
    with open(path, "rb") as f:
        for size, off in ((2048, 0), (2352, 16), (2352, 24), (2336, 8)):
            f.seek(16 * size + off + 1)
            if f.read(5) == b"CD001":
                return size, off
    return None


def parse_cue(path):
    """[{n, mode, file, start (sector in its file)}] for every track of a .cue."""
    tracks, file = [], None
    base = os.path.dirname(path)
    for line in open(path, encoding="latin-1"):
        w = line.strip().split()
        if not w:
            continue
        k = w[0].upper()
        if k == "FILE":
            name = re.match(r'\s*FILE\s+"?(.*?)"?\s+\w+\s*$', line, re.I).group(1)
            file = ci(base, os.path.basename(name.replace("\\", "/"))) or os.path.join(base, name)
        elif k == "TRACK":
            tracks.append({"n": int(w[1]), "mode": w[2].upper(), "file": file, "start": None})
        elif k == "INDEX" and tracks and int(w[1]) == 1:
            m, s, fr = (int(x) for x in w[2].split(":"))
            tracks[-1]["start"] = (m * 60 + s) * 75 + fr
    return tracks


def find_cue(folder, stem=None):
    """A .cue in the folder whose files exist (the same name as the image first)."""
    try:
        cues = sorted(n for n in os.listdir(folder) if n.lower().endswith(".cue"))
    except FileNotFoundError:
        return None
    if stem:
        cues.sort(key=lambda n: os.path.splitext(n)[0].lower() != stem.lower())
    for n in cues:
        p = os.path.join(folder, n)
        try:
            t = parse_cue(p)
        except Exception:
            continue
        if t and all(x["file"] and os.path.exists(x["file"]) for x in t):
            return p
    return None


def extract_data(image, layout, work):
    """The data track's files, via 7z (ISO 9660 / Joliet). A raw image is cut to 2048-byte sectors first."""
    iso = image
    if layout != (2048, 0):
        size, off = layout
        iso = os.path.join(work, "data.iso")
        say(f"  cutting the data track out of {size}-byte sectors")
        with open(image, "rb") as f, open(iso, "wb") as o:
            # a data track ends where the image's file system says (the volume's size in the PVD)
            f.seek(16 * size + off + 80)
            blocks = struct.unpack("<I", f.read(4))[0]
            f.seek(0)
            for _ in range(blocks):
                s = f.read(size)
                if len(s) < size:
                    break
                o.write(s[off:off + 2048])
    dest = os.path.join(work, "disc")
    r = subprocess.run([seven_zip(), "x", "-y", f"-o{dest}", iso], capture_output=True, text=True)
    if r.returncode != 0:
        fail(f"could not read the disc's files (7z: {r.stderr.strip() or r.stdout.strip()[-300:]})")
    return dest


def music(cue, out):
    """CD audio tracks -> game/music/trackNN.mp3 (NN = the CD track: a level's REDBOOK a b plays a+1..b+1)."""
    tracks = parse_cue(cue)
    audio = [t for t in tracks if t["mode"] == "AUDIO" and t["start"] is not None]
    if not audio:
        return 0
    os.makedirs(out, exist_ok=True)

    def one(t):
        # it runs to the next track's start in the same file, else to the end of its file
        nxt = [u["start"] for u in tracks if u["file"] == t["file"] and u["start"] is not None and u["start"] > t["start"]]
        end = min(nxt) if nxt else os.path.getsize(t["file"]) // 2352
        dst = os.path.join(out, f"track{t['n']:02d}.mp3")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", "44100", "-ac", "2",
                        "-skip_initial_bytes", str(t["start"] * 2352), "-i", t["file"],
                        "-t", f"{(end - t['start']) / 75:.4f}", "-c:a", "libmp3lame", "-b:a", "128k", dst], check=True)
        return t["n"], (end - t["start"]) // 75

    with concurrent.futures.ThreadPoolExecutor(os.cpu_count() or 2) as pool:
        done = list(pool.map(one, audio))
    say(f"  music: {len(done)} tracks, {sum(s for _, s in done) // 60} min")
    return len(done)


def opus(game):
    """Every sound effect as Ogg Opus beside its wav (src/sound.ts loads the .ogg, the wav where it can't)."""
    wavs = [os.path.join(r, f) for r, _, fs in os.walk(os.path.join(game, "sfx")) for f in fs if f.endswith(".wav")]

    def one(w):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", w, "-af", "aresample=48000:resampler=soxr:precision=28",
                        "-c:a", "libopus", "-b:a", "96k", "-vbr", "on", "-application", "audio", "-frame_duration", "20",
                        "-map_metadata", "-1", w[:-4] + ".ogg"], check=True)

    with concurrent.futures.ThreadPoolExecutor(os.cpu_count() or 2) as pool:
        list(pool.map(one, wavs))
    return len(wavs)


# ------------------------------------------------------------------ main

def fingerprint(path):
    """What the output was made from: the input's bytes (or a folder's names + sizes) + this tool's code."""
    h = hashlib.sha256()
    if os.path.isdir(path):
        for r, ds, fs in os.walk(path):
            ds.sort()
            for f in sorted(fs):
                p = os.path.join(r, f)
                h.update(f"{os.path.relpath(p, path)}:{os.path.getsize(p)}\n".encode())
    else:
        with open(path, "rb") as f:
            for b in iter(lambda: f.read(1 << 20), b""):
                h.update(b)
    for v in VERSION_FILES:
        h.update(open(v, "rb").read())
    h.update(b"no-music" if "--no-music" in flags else b"music")
    return h.hexdigest()


def main():
    t0 = time.time()
    if not os.path.exists(INPUT):
        fail(f"{INPUT} not found")
    stamp_file = os.path.join(OUT, ".prepared.json")
    say("checking the input…")
    fp = fingerprint(INPUT)
    try:
        old = json.load(open(stamp_file))
    except Exception:
        old = None
    if old and old.get("fingerprint") == fp and os.path.isdir(os.path.join(OUT, "game")) and "--rebuild" not in flags:
        say(f"already converted from this input ({old.get('summary', '')}) — nothing to do")
        return

    work = tempfile.mkdtemp(prefix="game-prepare-")
    try:
        # 1. find the game's files and the music
        cue = None
        src = INPUT
        kind = archive_kind(src) if os.path.isfile(src) else None
        if kind:
            # a downloaded archive (.7z / .zip / .rar): unpacked here, then searched like a folder
            say(f"{kind} archive: unpacking…")
            src = os.path.join(work, "archive")
            r = subprocess.run([seven_zip(), "x", "-y", f"-o{src}", INPUT], capture_output=True, text=True)
            if r.returncode != 0:
                fail(f"could not unpack {os.path.basename(INPUT)} (7z: {(r.stderr or r.stdout).strip()[-300:]})")
        if os.path.isdir(src):
            root = game_root(src)
            if not root:
                # a folder holding a disc image (also one level or two down, as archives often have it)
                imgs = [os.path.join(r, n) for r, _, fs in walk(src, 3) for n in fs if sector_layout(os.path.join(r, n))]
                if not imgs:
                    fail(f"no compatible game folder (levels/, cars/, wavs/) or disc image found in {os.path.basename(INPUT.rstrip('/'))}")
                image = max(imgs, key=os.path.getsize)
                say(f"found the disc image {os.path.relpath(image, src)}")
                cue = find_cue(os.path.dirname(image), os.path.splitext(os.path.basename(image))[0])
            else:
                image = None
                say(f"game folder: {os.path.relpath(root, src) if root != src else '.'}")
                cue = None
            cue = cue or next((c for r, _, _ in walk(src, 3) for c in [find_cue(r)] if c), None)
        else:
            image = INPUT
            if INPUT.lower().endswith(".cue"):
                cue = INPUT
                data = [t for t in parse_cue(INPUT) if t["mode"] != "AUDIO"]
                if not data or not data[0]["file"] or not os.path.exists(data[0]["file"]):
                    fail(f"{INPUT} names no data track file that exists")
                image = data[0]["file"]
            else:
                cue = find_cue(os.path.dirname(INPUT), os.path.splitext(os.path.basename(INPUT))[0])
        if image:
            layout = sector_layout(image)
            if not layout:
                fail(f"{os.path.basename(image)} is not a CD image with a data track (no ISO 9660 file system found)")
            kind = {2048: "ISO (2048-byte sectors)", 2352: "raw CD image (2352-byte sectors)", 2336: "raw CD image (2336-byte sectors)"}[layout[0]]
            say(f"disc image: {kind}")
            root = game_root(extract_data(image, layout, work))
            if not root:
                fail("the disc has no compatible game folder (levels/, cars/, wavs/) on it")
        if "--no-music" in flags:
            cue = None
            say("music: off (--no-music)")
        elif cue:
            say(f"music from {os.path.basename(cue)}")
        else:
            say("music: none — " + ("an installed game has no CD music (give the disc's .cue + .bin to include it)" if not image
                else "no .cue with CD audio found next to the input (a plain .iso holds no music)"))

        # 2. is it all there?
        want = levels()
        lv = ci(root, "levels")
        missing = [l for l in want if not ci(lv, l)]
        if missing:
            fail(f"levels missing from the game files: {', '.join(missing)}")
        cars = [n for n in os.listdir(ci(root, "cars")) if os.path.isdir(os.path.join(ci(root, "cars"), n))]
        say(f"game files: {len(want)} levels, {len(cars)} car folders")

        # 3. convert, into a new folder that replaces the old one at the end
        new = os.path.join(OUT, "game.new")
        shutil.rmtree(new, ignore_errors=True)
        os.makedirs(new)
        say("converting tracks, cars, sounds, weapons, HUD…")
        env = dict(os.environ, RV=root, OUT=new, PYTHONDONTWRITEBYTECODE="1")
        jobs = [[l] for l in want] + [["cars"], ["sounds"], ["weapons"], ["hud"]]

        def run(job):
            r = subprocess.run([sys.executable, "-I", CONVERT, *job], env=env, capture_output=True, text=True)
            return job, r

        problems = []
        with concurrent.futures.ThreadPoolExecutor(os.cpu_count() or 2) as pool:
            for job, r in pool.map(run, jobs):
                if r.returncode != 0:
                    fail(f"converting {job[0]} failed:\n{r.stderr.strip()[-2000:]}")
                problems += [f"{job[0]}: {l.strip()}" for l in r.stdout.splitlines() if "missing" in l.lower()]
        for p in problems:
            say("  warning:", p)
        tracks = music(cue, os.path.join(new, "music")) if cue else 0
        say(f"  sound effects as Opus: {opus(new)}")
        # the levels' names as the game shows them
        names, from_exe = level_names(want, root, [root] + ([os.path.dirname(root)] if image else [src]))
        json.dump(names, open(os.path.join(new, "levels.json"), "w"), indent=1, ensure_ascii=False)
        say(f"  level names: {from_exe} of {len(want)} from the game's exe" + ("" if from_exe == len(want) else ", the rest from the levels' .inf files"))
        # 4. the CPU drivers' training (this project's own files, in the image)
        n = 0
        for l in want:
            src = os.path.join(APP, "training", l)
            if os.path.isdir(src):
                for f in os.listdir(src):
                    if f.startswith("ai-") and f.endswith(".json"):
                        shutil.copyfile(os.path.join(src, f), os.path.join(new, l, f))
                        n += 1
        say(f"  CPU driver training files: {n}")

        old_game = os.path.join(OUT, "game")
        if os.path.exists(old_game):
            shutil.rmtree(old_game)
        os.rename(new, old_game)
        size = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(old_game) for f in fs)
        summary = f"{len(want)} levels, {len(cars)} cars, {tracks} music tracks, {size / 1e6:.0f} MB"
        json.dump({"fingerprint": fp, "input": os.path.basename(INPUT.rstrip('/')), "summary": summary,
                   "at": time.strftime("%Y-%m-%d %H:%M:%S")}, open(stamp_file, "w"), indent=1)
        say(f"done in {time.time() - t0:.0f} s: {summary}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


main()
