"""Original PC game data -> web-ready files for the browser racing engine.

Stdlib only. Run in a throwaway container (no host installs):

  docker run --rm -v ./convert:/app:ro \
    -v <the game folder>:/rv:ro \
    -v ./src/public/game:/out \
    python:3.12-slim python -I /app/convert.py toy2

Coordinates: original game is x right, y DOWN, z forward, 1 unit ~ 1 cm. We rotate
180 deg about x and scale to metres: (x, y, z) -> (x, -y, -z) / 100, so +y is up
and a car's forward is -z (three.js convention). It is a rotation, not a
mirror: faces keep their handedness, but original game's front faces are clockwise,
so every triangle is emitted reversed for three.js (CCW front).

Outputs (each .json/.bin also gets a .gz sibling, served pre-gzipped):
  <track>/track.json + track.bin    render geometry (world + instances)
  <track>/collision.bin             f32 triangles (+ f32 surface id each)
  <track>/<page>.png                texture pages, black -> transparent
  cars/<car>/car.json + car.bin + car.png
  cars/index.json                   selectable cars
"""

import gzip
import json
import math
import os
import shutil
import re
import struct
import sys
import zlib

RV = os.environ.get("RV", "/rv")  # the game folder (tool/prepare.py points these elsewhere)
OUT = os.environ.get("OUT", "/out")
S = 0.01  # metres per original game unit


# ---------------------------------------------------------------- helpers

def find(path):
    """Case-insensitive lookup of a original game relative path (backslashes ok)."""
    parts = path.replace("\\", "/").split("/")
    cur = RV
    for p in parts:
        if not p:
            continue
        hit = None
        for name in os.listdir(cur):
            if name.lower() == p.lower():
                hit = name
                break
        if hit is None:
            return None
        cur = os.path.join(cur, hit)
    return cur


def C(x, y, z):
    return (x * S, -y * S, -z * S)


def write(path, data, gz=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if isinstance(data, str):
        data = data.encode()
    with open(path, "wb") as f:
        f.write(data)
    if gz:
        with open(path + ".gz", "wb") as f:
            f.write(gzip.compress(data, 9, mtime=0))


# ---------------------------------------------------------------- images

def read_bmp(path):
    b = open(path, "rb").read()
    off, = struct.unpack_from("<I", b, 10)
    w, h, _, bpp = struct.unpack_from("<iiHH", b, 18)
    flip = h > 0
    h = abs(h)
    px = bytearray(w * h * 3)
    if bpp == 24:
        stride = (w * 3 + 3) & ~3
        for y in range(h):
            row = off + (h - 1 - y if flip else y) * stride
            for x in range(w):
                bb, g, r = b[row + x * 3: row + x * 3 + 3]
                i = (y * w + x) * 3
                px[i: i + 3] = bytes((r, g, bb))
    elif bpp == 8:
        hdr, = struct.unpack_from("<I", b, 14)
        ncol, = struct.unpack_from("<I", b, 46)
        ncol = ncol or 256
        pal = [b[14 + hdr + i * 4: 14 + hdr + i * 4 + 3] for i in range(ncol)]
        stride = (w + 3) & ~3
        for y in range(h):
            row = off + (h - 1 - y if flip else y) * stride
            for x in range(w):
                bb, g, r = pal[b[row + x]]
                i = (y * w + x) * 3
                px[i: i + 3] = bytes((r, g, bb))
    else:
        raise ValueError(f"{path}: {bpp} bpp unsupported")
    return w, h, px


def keyed_rgba(w, h, rgb):
    """Black = transparent (original game's colour key). Transparent texels get the
    average colour of their opaque neighbours so bilinear filtering doesn't
    pull black fringes into the edges."""
    n = w * h
    a = bytearray(255 if (rgb[i * 3] | rgb[i * 3 + 1] | rgb[i * 3 + 2]) else 0 for i in range(n))
    out = bytearray(n * 4)
    for i in range(n):
        out[i * 4: i * 4 + 3] = rgb[i * 3: i * 3 + 3]
        out[i * 4 + 3] = a[i]
    for _ in range(2):  # two dilation passes
        fill = []
        for y in range(h):
            for x in range(w):
                i = y * w + x
                if a[i]:
                    continue
                r = g = bl = c = 0
                for dy in (-1, 0, 1):
                    yy = y + dy
                    if yy < 0 or yy >= h:
                        continue
                    for dx in (-1, 0, 1):
                        xx = x + dx
                        if xx < 0 or xx >= w:
                            continue
                        j = yy * w + xx
                        if a[j]:
                            r += out[j * 4]; g += out[j * 4 + 1]; bl += out[j * 4 + 2]; c += 1
                if c:
                    fill.append((i, r // c, g // c, bl // c))
        for i, r, g, bl in fill:
            out[i * 4: i * 4 + 3] = bytes((r, g, bl))
            a[i] = 1  # counts as a source for the next pass; alpha stays 0
    return out


def png(w, h, rgba):
    raw = b"".join(b"\0" + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


HD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hd")


def texture(src, dst):
    w, h, rgb = read_bmp(src)
    write(dst, png(w, h, keyed_rgba(w, h, rgb)), gz=False)
    # an AI-upscaled page (optional, not part of this repository) at the same path under convert/hd/ (e.g. hd/toylite/toylitea.png,
    # RGBA, a whole multiple of the original) replaces it; w, h stay the original's (UVs are 0..1)
    hd = os.path.join(HD, os.path.relpath(dst, OUT))
    if os.path.exists(hd):
        shutil.copyfile(hd, dst)
    return w, h


# ---------------------------------------------------------------- meshes

POLY_QUAD = 0x001
POLY_DOUBLE = 0x002
POLY_TRANS = 0x004
POLY_ADD = 0x100
POLY_NOENV = 0x400  # car bodies: no environment map on this face


def read_polys(b, off, pc, vc):
    """One PRM/W mesh body. Returns (polys, verts, new offset)."""
    polys = []
    for _ in range(pc):
        t, tex = struct.unpack_from("<hh", b, off)
        idx = struct.unpack_from("<4H", b, off + 4)
        cols = struct.unpack_from("<4I", b, off + 12)
        uvs = struct.unpack_from("<8f", b, off + 28)
        polys.append((t, tex, idx, cols, uvs))
        off += 60
    verts = []
    for _ in range(vc):
        verts.append(struct.unpack_from("<3f", b, off))
        off += 24
    return polys, verts, off


def read_prm(path):
    """First (highest detail) LOD of a .prm."""
    b = open(path, "rb").read()
    pc, vc = struct.unpack_from("<hh", b, 0)
    polys, verts, _ = read_polys(b, 4, pc, vc)
    return polys, verts


class MeshBuilder:
    """Unwelded triangles grouped by material key."""

    def __init__(self):
        self.groups = {}  # key -> [pos, uv, col]

    def add_poly(self, key, pts, uvs, cols):
        g = self.groups.setdefault(key, ([], [], []))
        n = len(pts)
        tris = [(0, 2, 1)] if n == 3 else [(0, 2, 1), (0, 3, 2)]  # reversed winding
        for tri in tris:
            for k in tri:
                g[0].extend(pts[k])
                g[1].extend(uvs[k])
                g[2].extend(cols[k])

    def pack(self):
        """-> (bin bytes, meta). Layout: positions f32 | uv f32 | colour u8x4."""
        keys = sorted(self.groups, key=lambda k: (k[1], k[2], k[0]))  # opaque first
        pos, uv, col, groups = [], [], [], []
        start = 0
        for k in keys:
            p, u, c = self.groups[k]
            n = len(p) // 3
            groups.append({"tex": k[0], "blend": k[1], "double": bool(k[2]), "start": start, "count": n,
                           **({"env": bool(k[3])} if len(k) > 3 else {})})
            pos.extend(p); uv.extend(u); col.extend(c)
            start += n
        n = start
        data = struct.pack(f"<{n * 3}f", *pos) + struct.pack(f"<{n * 2}f", *uv) + bytes(col)
        return data, {"vertices": n, "groups": groups,
                      "layout": {"position": 0, "uv": n * 12, "color": n * 20}}


def blend_of(t):
    if t & POLY_ADD:
        return 2  # additive
    if t & POLY_TRANS:
        return 1  # alpha from vertex colour
    return 0


def colour(c, scale, mul=(1, 1, 1), trans=False):
    r = (c >> 16) & 255
    g = (c >> 8) & 255
    b = c & 255
    a = (c >> 24) & 255 if trans else 255
    return (max(0, min(255, int(r * scale * mul[0]))), max(0, min(255, int(g * scale * mul[1]))),
            max(0, min(255, int(b * scale * mul[2]))), a)


def add_polys(mb, polys, verts, xf, scale=1.0, mul=(1, 1, 1), tex_map=None, env=False, lights=None):
    """env: split off the faces a car's chrome may cover (all but those flagged 0x400) -> group "env".
    lights: the level's world lights (read_lights), added to the vertex colours as the game does."""
    for t, tex, idx, cols, uvs in polys:
        n = 4 if t & POLY_QUAD else 3
        pts = [xf(verts[idx[k]]) for k in range(n)]
        uv = [(uvs[k * 2], uvs[k * 2 + 1]) for k in range(n)]
        trans = bool(t & POLY_TRANS)
        cl = [colour(cols[k], scale, mul, trans) for k in range(n)]
        if lights:
            nrm = face_normal(pts)
            dbl = bool(t & POLY_DOUBLE)
            for k in range(n):
                dr, dg, db = light_at(lights, pts[k], nrm, dbl)
                if dr or dg or db:
                    c = cl[k]
                    cl[k] = (max(0, min(255, int(c[0] + dr))), max(0, min(255, int(c[1] + dg))), max(0, min(255, int(c[2] + db))), c[3])
        tx = tex if tex_map is None else tex_map(tex)
        key = (tx, blend_of(t), 1 if t & POLY_DOUBLE else 0)
        mb.add_poly(key + (0 if t & POLY_NOENV else 1,) if env else key, pts, uv, cl)


def face_normal(pts):
    """Front-face normal (our coords): original game's front faces wind clockwise."""
    a, b, c = pts[0], pts[1], pts[2]
    u = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    v = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
    l = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2) or 1
    return (n[0] / l, n[1] / l, n[2] / l)


def read_lights(path):
    """.lit: i32 count, 72-byte lights: pos, reach, 3x3 (rows right/up/look: a spot shines along
    look), cone (degrees), r g b (can be over 255, or negative: a shadow), flag, type, speed, pad.
    Flag 1 = lights the world (the game adds it to the vertex colours when the level loads),
    flag 2 = lights cars and objects as they pass. Type 0 omni, 1 omni facing (faces turned away
    get none), 2 spot, 3 spot facing, 4 (Toys in the Hood's street lamps: cars only)."""
    if not path:
        return []
    b = open(path, "rb").read()
    n, = struct.unpack_from("<i", b, 0)
    out = []
    for i in range(n):
        v = struct.unpack_from("<17f4B", b, 4 + i * 72)
        look = C(*v[10:13])
        ll = math.sqrt(sum(c * c for c in look)) or 1
        out.append({"pos": [round(c, 3) for c in C(*v[0:3])], "reach": round(v[3] * S, 3),
                    "dir": [round(c / ll, 4) for c in look], "cone": v[13], "rgb": [v[14], v[15], v[16]],
                    "flag": v[17], "type": v[18]})
    return out


def light_at(lights, p, nrm, double):
    """Colour a light set adds at point p (our coords) on a face with normal nrm (0..255 units)."""
    r = g = b = 0.0
    for L in lights:
        dx, dy, dz = p[0] - L["pos"][0], p[1] - L["pos"][1], p[2] - L["pos"][2]
        d2 = dx * dx + dy * dy + dz * dz
        reach = L["reach"]
        if d2 >= reach * reach:
            continue
        d = math.sqrt(d2) or 1e-6
        k = 1 - d / reach
        t = L["type"]
        if t in (1, 3):
            f = -(nrm[0] * dx + nrm[1] * dy + nrm[2] * dz) / d
            if double:
                f = abs(f)
            if f <= 0:
                continue
            k *= f
        if t in (2, 3):
            cosang = (L["dir"][0] * dx + L["dir"][1] * dy + L["dir"][2] * dz) / d
            ang = math.degrees(math.acos(max(-1, min(1, cosang))))
            if ang >= L["cone"]:
                continue
            k *= 1 - ang / L["cone"]
        r += L["rgb"][0] * k
        g += L["rgb"][1] * k
        b += L["rgb"][2] * k
    return r, g, b


# ---------------------------------------------------------------- ambient sounds

# Each level loads one folder of wavs/ after the 43 common effects (in the original executable's
# order), and .fob objects of type 49 are its ambient sounds: params
# [sound, range, occasional, ?]. `sound` indexes a 40-entry table of effect
# numbers; 43 + k is the k-th file of the level's folder.
LEVEL_SFX = {
    "toy": ["piano", "plane", "copter", "dragon", "creak", "train", "whistle", "arcade", "toybrick"],
    "hood": ["basketball", "birds1", "birds2", "birds3", "dogbark", "kids", "sprink", "tv", "lawnmower", "digger",
             "stream", "cityamb2", "roadcone"],
    "garden": ["tropics2", "tropics3", "tropics4", "stream", "animal1", "animal2", "animal3", "animal4"],
    "muse": ["museumam", "laserhum", "alarm2", "escalate", "rotating", "largdoor"],
    "market": ["aircond1", "cabnhum2", "carpark", "freezer1", "iceyarea", "sdrsopen", "sdrsclos", "carton"],
    "ghost": ["coyote1", "bats", "eagle1", "minedrip", "rattler", "townbell", "tumbweed"],
    "ship": ["intamb1", "seagulls", "shiphorn", "strmrain", "thunder1", "wash"],
}
AMBIENT_SFX = [44, 47, 48, 50, 51, 52, 45, 46, 50, 53, 43, 44, 45, 43, 43, 44, 45, 46, 47, 46,
               47, 48, 46, 43, 44, 45, 46, 47, 43, 44, 45, 47, 46, 48, 47, 48, 49, 50, 54, 48]
LEVEL_FOLDER = {"toylite": "toy", "toy2": "toy", "nhood1": "hood", "nhood2": "hood", "garden1": "garden",
                "muse1": "muse", "muse2": "muse", "market1": "market", "market2": "market",
                "wild_west1": "ghost", "wild_west2": "ghost", "ship1": "ship", "ship2": "ship"}


def level_wavs(name):
    """Every wav of the level's folder, for the objects that play them (lasers, sprinklers, doors...)."""
    folder = LEVEL_FOLDER.get(name)
    d = find(f"wavs/{folder}") if folder else None
    if not d:
        return
    for f in os.listdir(d):
        if f.lower().endswith(".wav"):
            dst = os.path.join(OUT, "sfx", folder, f.lower())
            if not os.path.exists(dst):
                write(dst, open(os.path.join(d, f), "rb").read())


def ambient_sounds(name, fob_path):
    """Type 49 objects -> [{pos, sound ('folder/file'), range m, occasional}], wavs copied to sfx/<folder>/."""
    folder = LEVEL_FOLDER.get(name)
    if not folder or not fob_path:
        return []
    out = []
    fb = open(fob_path, "rb").read()
    fc, = struct.unpack_from("<i", fb, 0)
    for i in range(fc):
        o = 4 + i * 56
        typ, snd, rng, occ = struct.unpack_from("<4i", fb, o)
        if typ != 49 or not 0 <= snd < len(AMBIENT_SFX):
            continue
        k = AMBIENT_SFX[snd] - 43
        files = LEVEL_SFX[folder]
        if not 0 <= k < len(files):
            continue
        src = find(f"wavs/{folder}/{files[k]}.wav")
        if not src:
            continue
        dst = os.path.join(OUT, "sfx", folder, files[k] + ".wav")
        if not os.path.exists(dst):
            write(dst, open(src, "rb").read())
        out.append({"pos": [round(c, 3) for c in C(*struct.unpack_from("<3f", fb, o + 20))],
                    "sound": f"{folder}/{files[k]}", "range": rng, "occasional": bool(occ)})
    return out


def mirror_planes(rim, setting):
    """Reflective floors: .rim = i16 count, then per plane (92 bytes) i32 flags, plane (normal, d),
    bounding box (x0 x1 y0 y1 z0 z1), 4 corners. All are level rectangles. The .inf's MIRRORS
    type mix intensity distance: how strong the reflection is (type 0: mix, type 1: intensity) and
    how high above the floor (cm) a car still shows in it."""
    if not rim or not isinstance(setting, list):
        return None
    b = open(rim, "rb").read()
    n, = struct.unpack_from("<h", b, 0)
    planes = []
    for i in range(n):
        v = struct.unpack_from("<i22f", b, 2 + i * 92)
        x0, x1, y0, y1, z0, z1 = v[5:11]
        planes.append({"y": round(-y0 * S, 3), "x": [round(x0 * S, 3), round(x1 * S, 3)],
                       "z": [round(-z1 * S, 3), round(-z0 * S, 3)]})
    typ, mix, intensity, dist = setting
    # type 0: original executable gives the mirror floor's own faces an alpha of mix and
    # draws them over the reflection, so the reflection shows 1 - mix of itself (it was read as mix:
    # Supermarket 2's 0.85 made a near-solid second car under each car — "Phat slug seems
    # broken"). Type 1 (museums): the reflection's intensity
    return {"strength": intensity if typ == 1 else round(1 - mix, 3), "fade": dist * S, "planes": planes}


# ---------------------------------------------------------------- level objects

# .fob object types (original executable's editor names, in enum order: Spinning Barrel 0, Beachball 1,
# Planet 2, Plane 3, Copter 4, Dragon 5, Water 6, Trolley 7, Boat 8, Speedup 9, Radar 10,
# Balloon 11, Horse 12, Train 13, Strobe 14, ... 3D Sound 49, Star 50, ... ABC Block 67) and the
# models each one is drawn with (models/*.m; texture index k = the level's page k, except the
# dragon's own levels/toy2/dragon.bmp and the sun's levels/muse2/sun.bmp)
OBJECT_MODELS = {
    1: ["beachball"], 3: ["plane", "plane2"], 4: ["copter", "copter2", "copter3"],
    5: ["dragon1", "dragon2", "dragon3"], 8: ["boat1", "boat2"], 10: ["radar"], 11: ["balloon"],
    12: ["horse"],
    # knocked about by the cars (shared/objects.ts KNOCK): bottles, traffic cones, packets, ABC blocks
    57: ["bottle"], 59: ["trafficcone"], 66: ["packet", "packet1"], 67: ["abcblock"],
    # (2026-10-13, from original executable's object table — init function + data size per type)
    6: ["water"],  # Toy World 1's pond: models/water.m, levels/toylite/water.bmp, its vertices bob
    52: ["tumble_weed"], 54: ["lantern"], 56: ["slider"], 65: ["shiplight"],
    0: ["barrel"],  # Museum 2's turning space tunnel (57 x 70 m), [speed]
    41: ["sphose"], 50: ["star"],
    42: ["basketball"],  # the object thrower: what Toys in the Hood 1's throws
}
# types drawn with one model picked by their first parameter
OBJECT_MODEL_BY_P0 = {
    14: ["light1", "light2", "light3"],  # strobe: museum (cyan), museum ramps (red), Hood (orange)
    # water ripples: the exe's table (model, texture page 32/33 — a ripple height field
    # the game simulates and draws as a texture, src/water.ts)
    69: ["stream", "poolwater", "gardenwater1", "gardenwater2", "gardenwater3", "gardenwater4"],
}
# streams (type 47, exe table: model, wave height, the water picture): Hood 2's stream, the
# Toytanic pool's surface, a garden pond. Both Toytanics use levels/ship1/water.bmp
STREAMS = [("stream", "levels/nhood2/water.bmp", 2.0), ("poolwater", "levels/ship1/water.bmp", 2.0),
           ("gardenwater1", "levels/ship1/water.bmp", 0.2)]
OBJECT_MODEL_BY_P0[47] = [m for m, _, _ in STREAMS]
# types with no model, only their place and parameters: rain, lightning, water box (half size in cm),
# trolley (drawn as cars/trolley), spark generator, laser, clouds, flag, dolphin, fog box
OBJECT_NO_MODEL = {63, 64, 68, 7, 16, 33, 38, 70, 71, 73}
# per-level model swaps: Toys in the Hood 2's cones are models/n2trafficcone.m (its stripes are on that
# level's page b; trafficcone.m reads page c, where Hood 2 has beige — the cones came out plain)
LEVEL_MODELS = {"nhood2": {"trafficcone": "n2trafficcone"}}
# Planet's first parameter: which one (exe's names in order), drawn with models/<name>.m
PLANETS = ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune", "pluto", "moon", "rings", "sun"]


def level_objects(name, files, out, pages_of, modelper=1.0):
    """Animated level objects (.fob) -> (list, model metas, static collision triangles); models
    written to objects.bin. The dragon's body is solid (models/dragon1.ncp); the rest are overhead
    (planes, copter, balloon, planets) or moved in shared/objects.ts (horses, beach ball)."""
    fob = files.get(f"{name}.fob")
    if not fob:
        return [], {}, []
    col = []
    fb = open(fob, "rb").read()
    fc, = struct.unpack_from("<i", fb, 0)
    objs, want = [], []
    for i in range(fc):
        o = 4 + i * 56
        typ, *params = struct.unpack_from("<5i", fb, o)
        if typ not in OBJECT_MODELS and typ not in OBJECT_MODEL_BY_P0 and typ not in OBJECT_NO_MODEL and typ not in (2, 40):
            continue
        pos = struct.unpack_from("<3f", fb, o + 20)
        up = struct.unpack_from("<3f", fb, o + 32)
        look = struct.unpack_from("<3f", fb, o + 44)
        right = (up[1] * look[2] - up[2] * look[1], up[2] * look[0] - up[0] * look[2], up[0] * look[1] - up[1] * look[0])
        if typ == 2:
            k = params[0]
            models = [PLANETS[k] if k < 11 else "sphere"] if 0 <= k < len(PLANETS) else []
        elif typ in OBJECT_NO_MODEL:
            models = []
        elif typ == 40:  # sprinkler: base + head (the garden has its own)
            models = ["spbasegarden", "spheadgarden"] if name == "garden1" else ["spbase", "sphead"]
        elif typ in OBJECT_MODEL_BY_P0:
            table = OBJECT_MODEL_BY_P0[typ]
            models = [table[params[0]]] if 0 <= params[0] < len(table) else []
        else:
            models = [LEVEL_MODELS.get(name, {}).get(m, m) for m in OBJECT_MODELS[typ]]
        models = [m for m in models if find(f"models/{m}.m")]
        if not models and typ not in OBJECT_NO_MODEL:
            continue
        want += [m for m in models if m not in want]
        if typ in SOLID_BOX and models:
            col += model_box(find(f"models/{models[0]}.m"), right + up + look, pos, flip=typ in BOX_FLIP)
        if typ == 5 and find("models/dragon1.ncp"):
            col += ncp_triangles(find("models/dragon1.ncp"), xf=lambda v, m=right + up + look, pos=pos: mat_apply(m, pos, v))
        o_ = {"type": typ, "pos": [round(c, 3) for c in C(*pos)],
              "rot": [[round(v, 4) for v in r] for r in rv_matrix_to_three(right + up + look)],
              "p": params, "models": models}
        if typ == 70:
            # the flag's picture: 73 x 49 px of a level page — Ghost Town 2 (the exe's level
            # 11) page c at (0, 198), else page g at (64, 128): the Stars and Stripes
            page, uv = (2, [0, 198]) if name == "wild_west2" else (6, [64, 128])
            o_["tex"] = pages_of(page)
            o_["uv"] = uv + [73, 49]
        if typ == 38 and find("gfx/clouds.bmp"):
            texture(find("gfx/clouds.bmp"), os.path.join(OUT, "fx", "clouds.png"))
        objs.append(o_)
    if not objs:
        return [], {}, []
    blob, metas = b"", {}
    for m in want:
        polys, verts = read_prm(find(f"models/{m}.m"))
        mb = MeshBuilder()
        add_polys(mb, polys, verts, lambda v: C(*v), modelper)
        d, mm = mb.pack()
        mm["layout"] = {k: v + len(blob) for k, v in mm["layout"].items()}
        blob += d + b"\0" * ((-len(d)) % 4)
        special = {"dragon1": "dragon", "dragon2": "dragon", "dragon3": "dragon", "sphere": "sun", "water": "water"}.get(m)
        stream = next((bmp for sm, bmp, _ in STREAMS if sm == m), None)
        for g in mm["groups"]:
            if stream and m != "gardenwater1" and find(stream):
                texture(find(stream), os.path.join(out, "stream.png"))
                g["texture"] = "stream.png"
            elif special == "water" and files.get("water.bmp"):
                # untextured in the file: the game puts levels/<level>/water.bmp on it
                texture(files["water.bmp"], os.path.join(out, "water.png"))
                g["texture"] = "water.png"
            elif g["tex"] < 0:
                g["texture"] = None
            elif special and files.get(f"{special}.bmp"):
                fn = f"{special}.png"
                texture(files[f"{special}.bmp"], os.path.join(out, fn))
                g["texture"] = fn
            else:
                g["texture"] = pages_of(g["tex"])
        metas[m] = mm
    write(os.path.join(out, "objects.bin"), blob)
    return objs, metas, col


# ---------------------------------------------------------------- track

def parse_inf(path):
    info = {}
    for line in open(path, encoding="latin-1"):
        line = line.split(";")[0].strip()
        if not line:
            continue
        m = re.match(r"(\w+)\s+(.*)", line)
        if not m:
            continue
        k, v = m.group(1).upper(), m.group(2).strip()
        if v.startswith("'"):
            info[k] = v.strip("'")
        else:
            try:
                nums = [float(x) for x in v.split()]
                info[k] = nums[0] if len(nums) == 1 else nums
            except ValueError:
                info[k] = v
    return info


# props flagged "no collision" (64) that are made to be driven on
DRIVE_ON = {"mine_ramp.prm"}

# AI racing-line nodes to skip, per (level, reversed): (from, skipped, to) relinks from -> to. The
# reversed Supermarket 1's line left the start, ran 13 m the wrong way up to the toy helicopter and
# hairpinned back (the forward line's wide sweep through that corner, taken backwards): CPU cars
# set off the wrong way and got stuck there
AI_SKIP = {("market1", True): [(181, 108, 109)]}


# Objects with no .ncp that cars must not drive through (the Toytanic ship lights
# on the deck were drive-through) — a box round the model: 54 lantern (Ghost Town 2; they hang at
# the ceiling, out of reach), 65 ship light (drawn upright, turned half round x: src/objects.ts)
SOLID_BOX = {54, 65}
BOX_FLIP = {65}


def model_box(path, m, pos, surf=0, flip=False):
    """12 triangles of the model's bounding box, placed like the object, facing out."""
    _, verts = read_prm(path)
    if flip:
        verts = [(v[0], -v[1], -v[2]) + tuple(v[3:]) for v in verts]
    lo = [min(v[k] for v in verts) for k in range(3)]
    hi = [max(v[k] for v in verts) for k in range(3)]
    corner = lambda i, j, k: C(*mat_apply(m, pos, (hi[0] if i else lo[0], hi[1] if j else lo[1], hi[2] if k else lo[2])))
    P = {(i, j, k): corner(i, j, k) for i in (0, 1) for j in (0, 1) for k in (0, 1)}
    mid = [sum(p[a] for p in P.values()) / 8 for a in range(3)]
    faces = []
    for ax in range(3):
        for side in (0, 1):
            q = [c for c in P if c[ax] == side]
            # the four corners in order round the face
            o = [k for k in range(3) if k != ax]
            ring = sorted(q, key=lambda c: (c[o[0]], c[o[1]]))
            ring = [ring[0], ring[1], ring[3], ring[2]]
            faces.append([P[c] for c in ring])
    out = []
    for f in faces:
        for tri in ((f[0], f[1], f[2]), (f[0], f[2], f[3])):
            a, b, c = tri
            u = [b[k] - a[k] for k in range(3)]
            w = [c[k] - a[k] for k in range(3)]
            n = (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])
            ctr = [(a[k] + b[k] + c[k]) / 3 - mid[k] for k in range(3)]
            if sum(n[k] * ctr[k] for k in range(3)) < 0:
                tri = (a, c, b)
            out.append(([list(v) for v in tri], surf))
    return out


def ncp_triangles(path, xf=None):
    """Collision polys (plane form) -> list of (tri vertices (3x3), surface)."""
    b = open(path, "rb").read()
    if len(b) < 2:  # some props ship an empty .ncp
        return []
    n, = struct.unpack_from("<h", b, 0)
    out = []
    for i in range(n):
        o = 2 + i * 112
        t, surf = struct.unpack_from("<ii", b, o)
        pl = [struct.unpack_from("<4f", b, o + 8 + k * 16) for k in range(5)]
        nv = 4 if t & 1 else 3
        vs = []
        for k in range(nv):
            v = solve3(pl[0], pl[1 + k], pl[1 + (k + 1) % nv])
            if v is None:
                break
            vs.append(v)
        if len(vs) != nv:
            continue
        if xf:
            vs = [xf(v) for v in vs]
        vs = [C(*v) for v in vs]
        for tri in ([(0, 2, 1)] if nv == 3 else [(0, 2, 1), (0, 3, 2)]):
            out.append(([vs[k] for k in tri], surf))
    return out


def solve3(p1, p2, p3):
    """Intersection of three planes n.x + d = 0 (Cramer)."""
    A = (p1[:3], p2[:3], p3[:3])
    rhs = (-p1[3], -p2[3], -p3[3])

    def det(m):
        return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))

    D = det(A)
    if abs(D) < 1e-9:
        return None
    res = []
    for c in range(3):
        M = [list(r) for r in A]
        for r in range(3):
            M[r][c] = rhs[r]
        res.append(det(M) / D)
    return tuple(res)


def mat_apply(m, pos, v):
    """original game instance matrix: rows are the model's right/up/look axes."""
    return (pos[0] + v[0] * m[0] + v[1] * m[3] + v[2] * m[6],
            pos[1] + v[0] * m[1] + v[1] * m[4] + v[2] * m[7],
            pos[2] + v[0] * m[2] + v[1] * m[5] + v[2] * m[8])


def rv_matrix_to_three(m):
    """3x3 original game basis (rows right/up/look) -> three.js basis columns."""
    # world_rv = M^T v_rv ; world_3 = F world_rv, v_rv = F v_3 (F = diag(1,-1,-1))
    F = (1, -1, -1)
    # (F M^T F)[i][j] = F[i] * M[j][i] * F[j]
    return [[F[i] * m[j * 3 + i] * F[j] for j in range(3)] for i in range(3)]


# Force fields (.fld: int count, 100-byte records; original executable loads them). A record: type,
# pos, 3x3 (rows = the box's axes), half size along them, direction, magnitude, damping (+ unused).
# What they are on the race levels is water: the Toy World 1 pond and the Toytanic pool lift (type 0)
# and right (type 1) a car, Toys in the Hood 2's stream carries cars along, Botanical Garden's
# stream damps them; the Ghost Towns' one type 4 is a whole-world field (gravity 4.5% lower).
# Applied in shared/fields.ts, units as original executable uses them (see there).
def force_fields(path):
    if not path:
        return []
    b = open(path, "rb").read()
    n, = struct.unpack_from("<i", b, 0)
    out = []
    for i in range(n):
        o = 4 + i * 100
        typ, = struct.unpack_from("<i", b, o)
        f = struct.unpack_from("<24f", b, o + 4)
        if typ not in (0, 1, 4):
            print("  force field of unknown type", typ)
            continue
        d = C(*f[15:18])
        out.append({"type": typ, "pos": [round(c, 3) for c in C(*f[0:3])],
                    "rot": [[round(v, 4) for v in r] for r in rv_matrix_to_three(f[3:12])],
                    "half": [round(v * S, 3) for v in f[12:15]],
                    "dir": [round(v / S, 4) for v in d],  # C() scales by S: undo, a unit vector
                    "mag": f[18], "damp": f[19]})
    return out


def convert_track(name):
    d = find(f"levels/{name}")
    files = {f.lower(): os.path.join(d, f) for f in os.listdir(d)}
    out = os.path.join(OUT, name)
    inf = parse_inf(files[f"{name}.inf"])
    rgbper = inf.get("WORLDRGBPER", 100) / 100.0
    # brightness of the gouraud (vertex colours) per kind of mesh, as original executable applies them (checked
    # in its code, 2026-10-13): MODELRGBPER on the cars' 19 model parts and the level objects' .m
    # models (planes, horses... — written to track.json for the cars, src/carlight.ts), INSTANCERGBPER
    # on the .fin props. Both default to 100. The props had MODELRGBPER before: Museum props at 32%.
    modelper = inf.get("MODELRGBPER", 100) / 100.0
    instper = inf.get("INSTANCERGBPER", 100) / 100.0

    world = open(files[f"{name}.w"], "rb").read()
    lights = read_lights(files.get(f"{name}.lit"))
    # flag 1: baked into the world and its props, as the game does on loading the level
    world_lights = [L for L in lights if L["flag"] & 1 and L["type"] != 4]

    def build(fin_path):
        """World mesh + the .fin's props, baked into one geometry. Returns (data, meta, props, prop
        collision triangles) — each prop's own <model>.ncp, placed like the prop, unless flag 64 (DRIVE_ON excepted)."""
        mb = MeshBuilder()
        b = world
        mc, = struct.unpack_from("<i", b, 0)
        off = 4
        for _ in range(mc):
            off += 40  # bounding ball + box
            pc, vc = struct.unpack_from("<hh", b, off)
            polys, verts, off = read_polys(b, off + 4, pc, vc)
            add_polys(mb, polys, verts, lambda v: C(*v), rgbper, lights=world_lights)
        # instances (.fin, 72 bytes: name[9], r g b (signed), EnvRGB, priority, flags, pad, LOD bias,
        # pos, 3x3). Flags: 1 env-mapped, 2 hidden, 4 not mirrored, 8 ? (not collision), 16 tint
        # with r g b, 64 no collision (cars drive through: Ghost Town clutter). 8 is NOT "no collision":
        # read that way, Toytanic 2 lost its ramps and tables. (Read as 4 = hidden before: robots, cranes, trucks, signs... were all missing.)
        fin = open(fin_path, "rb").read()
        count, = struct.unpack_from("<i", fin, 0)
        props = []
        ptris = []
        for i in range(count):
            o = 4 + i * 72
            iname = fin[o:o + 9].split(b"\0")[0].decode().lower()
            r, g, bl = struct.unpack_from("<bbb", fin, o + 9)
            flags = fin[o + 17]
            pos = struct.unpack_from("<3f", fin, o + 24)
            m = struct.unpack_from("<9f", fin, o + 36)
            if flags & 0x02:  # hidden
                continue
            # 32: drawn nowhere but solid (Museum 1's "invisbox": a ramp surface over a step)
            invisible = bool(flags & 0x20)
            prm = files.get(iname + ".prm")
            if not prm:
                # the .fin keeps 8 characters of the name: whitepos -> whitepost.prm, rocking_ -> rocking_chair2.prm
                cands = sorted((k for k in files if k.endswith(".prm") and k.startswith(iname)), key=len)
                prm = files[cands[0]] if cands else None
            if not prm:
                print("  instance without model:", iname)
                continue
            polys, verts = read_prm(prm)
            # flag 16: the prop's colours scaled by (r g b + 128) / 128 each, capped at 255 — the original
            # multiplies, it doesn't add (added, Toy World 1's +117 Duplo bricks came out pastel
            # pink and cream instead of saturated red and yellow — "too bright?")
            mul = tuple((c + 128) / 128 for c in (r, g, bl)) if flags & 0x10 else (1, 1, 1)
            if not invisible:
                add_polys(mb, polys, verts, lambda v, m=m, pos=pos: C(*mat_apply(m, pos, v)), instper, mul, lights=world_lights)
            ncp = files.get(os.path.splitext(os.path.basename(prm))[0].lower() + ".ncp")
            # flag 64: no collision — Ghost Town 2's forward AI line runs straight through a box that
            # has it, and as collision its mine rails stopped every CPU car. Except the mine ramp,
            # which carries it too but is a jump to drive up ("this jump is not solid")
            if ncp and (not flags & 0x40 or os.path.basename(prm).lower() in DRIVE_ON):
                ptris += ncp_triangles(ncp, xf=lambda v, m=m, pos=pos: mat_apply(m, pos, v))
            props.append({"name": os.path.splitext(os.path.basename(prm))[0].lower(), "pos": [round(c, 3) for c in C(*pos)],
                          "flags": flags})
        data, meta = mb.pack()
        return data, meta, props, ptris

    data, meta, props, ptris = build(files[f"{name}.fin"])
    npolys = meta["vertices"] // 3
    ninst = len(props)
    write(os.path.join(out, "track.bin"), data)
    # reversed runs have their own props (start banners, signs, pennants facing the other way)
    rev_geo = None
    rdir = files.get("reversed")
    if rdir and os.path.isdir(rdir):
        rfin = [os.path.join(rdir, f) for f in os.listdir(rdir) if f.lower() == f"{name}.fin"]
        if rfin:
            rdata, rmeta, rprops, rtris = build(rfin[0])
            write(os.path.join(out, "track-rev.bin"), rdata)
            rev_geo = (rmeta, rprops, rtris)

    # --- the train (Toy World 2: .fob type 13). models/train.m is the engine, train2.m / train3.m
    # its big and small wheels, all on the level's own texture pages. The .fob gives only where it
    # stands and which way it faces (params all 0): its run is the game's own code. "run" is the
    # stretch of rails it travels, as distances from that spot along its facing, measured from the
    # collision (floor from z 58 to 106 m, tunnels at both ends): from fully inside one tunnel to
    # fully inside the other. "fwd" is the way the engine faces (and runs). shared/train.ts moves it.
    train = None
    fob = files.get(f"{name}.fob")
    if fob:
        fb = open(fob, "rb").read()
        fc, = struct.unpack_from("<i", fb, 0)
        for i in range(fc):
            o = 4 + i * 56
            if struct.unpack_from("<i", fb, o)[0] != 13:
                continue
            pos = C(*struct.unpack_from("<3f", fb, o + 20))
            look = C(*struct.unpack_from("<3f", fb, o + 44))
            ln = math.hypot(look[0], look[2]) or 1
            blob, models = b"", {}
            for key, m in (("body", "train"), ("big", "train2"), ("small", "train3")):
                polys, verts = read_prm(find(f"models/{m}.m"))
                mb = MeshBuilder()
                add_polys(mb, polys, verts, lambda v: C(*v), modelper)
                d, mm = mb.pack()
                mm["layout"] = {k: v + len(blob) for k, v in mm["layout"].items()}
                blob += d + b"\0" * ((-len(d)) % 4)
                models[key] = mm
            write(os.path.join(out, "train.bin"), blob)
            # the engine's front is the model's -z (original game's), against the object's look vector
            train = {"pos": [round(c, 3) for c in pos], "fwd": [round(-look[0] / ln, 4), 0, round(-look[2] / ln, 4)],
                     "run": [-20.5, 17.5], "models": models}

    # --- textures: tpage index k -> <name><letter>.bmp
    pages = {}
    for gm in [meta] + ([rev_geo[0]] if rev_geo else []) + (list(train["models"].values()) if train else []):
        for gr in gm["groups"]:
            k = gr["tex"]
            if k < 0 or k in pages:
                continue
            src = files.get(f"{name}{chr(ord('a') + k)}.bmp")
            if not src:
                print("  missing texture page", k)
                pages[k] = None
                continue
            fn = f"{name}{chr(ord('a') + k)}.png"
            texture(src, os.path.join(out, fn))
            pages[k] = fn
        for gr in gm["groups"]:
            gr["texture"] = pages.get(gr["tex"]) if gr["tex"] >= 0 else None

    def page(k):
        if k in pages:
            return pages[k]
        src = files.get(f"{name}{chr(ord('a') + k)}.bmp")
        pages[k] = None
        if src:
            pages[k] = f"{name}{chr(ord('a') + k)}.png"
            texture(src, os.path.join(out, pages[k]))
        return pages[k]
    objects, object_models, otris = level_objects(name, files, out, page, modelper)
    level_wavs(name)

    # --- collision: the level's .ncp + the props' own (they were drive-through before)
    wtris = ncp_triangles(files[f"{name}.ncp"])

    def write_col(fn, tris):
        flat = [c for t, _ in tris for v in t for c in v]
        mats = [float(s) for _, s in tris]
        write(os.path.join(out, fn), struct.pack(f"<{len(flat)}f", *flat) + struct.pack(f"<{len(mats)}f", *mats))
    tris = wtris + ptris + otris
    write_col("collision.bin", tris)
    if rev_geo:
        write_col("collision-rev.bin", wtris + rev_geo[2] + otris)

    def route(files, rev):
        """The parts a reversed run replaces (levels/<name>/reversed/: .taz .pan .fan .tri, STARTPOSREV)."""
        # --- track zones (laps / checkpoints)
        zones = []
        tb = open(files[f"{name}.taz"], "rb").read()
        zc, = struct.unpack_from("<i", tb, 0)
        for i in range(zc):
            z = struct.unpack_from("<i3f9f3f", tb, 4 + i * 64)
            zones.append({"id": z[0], "pos": C(*z[1:4]), "rot": rv_matrix_to_three(z[4:13]),
                          "half": [abs(z[13]) * S, abs(z[14]) * S, abs(z[15]) * S]})

        # --- pos nodes (race order)
        nodes = []
        pb = open(files[f"{name}.pan"], "rb").read()
        pn, pstart, ptotal = struct.unpack_from("<iif", pb, 0)
        for i in range(pn):
            n = struct.unpack_from("<3ff4i4i", pb, 12 + i * 48)
            nodes.append({"pos": C(*n[0:3]), "dist": n[3] * S,
                          "prev": [x for x in n[4:8] if x >= 0], "next": [x for x in n[8:12] if x >= 0]})

        # --- weapon pickups: .fob objects of type 30 (id, 4 flags, pos, up, look = 56 bytes)
        pickups = []
        fob = files.get(f"{name}.fob")
        if fob:
            fb = open(fob, "rb").read()
            fc, = struct.unpack_from("<i", fb, 0)
            for i in range(fc):
                oid, = struct.unpack_from("<i", fb, 4 + i * 56)
                if oid == 30:
                    pickups.append(C(*struct.unpack_from("<3f", fb, 4 + i * 56 + 20)))

        # --- AI nodes (.fan): the original AI's racing line. Each node is a segment
        # across the track (two ends), with the racing line and the overtaking line
        # as 0..1 between the ends, distance to the finish, priority, and links.
        # Layout (76 bytes): i32 priority, f32 racing line, f32 finish dist,
        # f32 overtaking line, i32 ?, i32 speed x2 (all 30: unused), i32 prev[2],
        # i32 next[2], then 2 ends of {i32 ?, f32 x,y,z}.
        ai = []
        fan = files.get(f"{name}.fan")
        if fan:
            ab = open(fan, "rb").read()
            an, = struct.unpack_from("<h", ab, 0)
            for i in range(an):
                o = 4 + i * 76
                prio, line, dist, over = struct.unpack_from("<ifff", ab, o)
                prev = [x for x in struct.unpack_from("<2i", ab, o + 28) if x >= 0]
                nxt = [x for x in struct.unpack_from("<2i", ab, o + 36) if x >= 0]
                a = C(*struct.unpack_from("<3f", ab, o + 48))
                b = C(*struct.unpack_from("<3f", ab, o + 64))
                ai.append({"a": [round(v, 4) for v in a], "b": [round(v, 4) for v in b], "line": round(line, 4),
                           "over": round(over, 4), "dist": round(dist * S, 2), "prio": prio & 0xff, "prev": prev, "next": nxt})

        for frm, skip, to in AI_SKIP.get((name, rev), []):
            ai[frm]["next"] = [to if k == skip else k for k in ai[frm]["next"]]
            ai[to]["prev"] = [frm if k == skip else k for k in ai[to]["prev"]]
            # (the skipped node keeps its own links: a car that finds itself there still has a way on)

        # --- triggers (.tri, 68 bytes: i32 type, i32 data, pos, 3x3 matrix, half size).
        # Type 0 is the piano (Toy World 1): the key under a car is its position along the box.
        # Type 2 is a direction sign: the arrow (FX page 2) shown while a car is in the box. The low
        # 16 bits of data pick it — by the track's turn after each one: 0-3 chicane, U-turn, sharp
        # turn, bend to the left; 4-7 the same to the right; 8 straight on (the common one where the
        # track barely turns); 9-11 danger / fork / cross (taken in page order — no turn data
        # tells these apart). The high 16 bits number the signs.
        piano = []
        signs = []
        # type 1: the split-time checkpoints (data low 16 bits = which split, 0..), type 6: fires the
        # object thrower with the same ID (data) — Toys in the Hood 1's basketballs
        splits = []
        throws = []
        tri = files.get(f"{name}.tri")
        if tri:
            tb = open(tri, "rb").read()
            tn, = struct.unpack_from("<i", tb, 0)
            for i in range(tn):
                o = 4 + i * 68
                typ, data = struct.unpack_from("<ii", tb, o)
                if typ == 2:
                    signs.append({"pos": C(*struct.unpack_from("<3f", tb, o + 8)),
                                  "rot": rv_matrix_to_three(struct.unpack_from("<9f", tb, o + 20)),
                                  "half": [abs(v) * S for v in struct.unpack_from("<3f", tb, o + 56)],
                                  "sign": data & 0xFFFF})
                if typ in (1, 6):
                    (splits if typ == 1 else throws).append({
                        "pos": C(*struct.unpack_from("<3f", tb, o + 8)),
                        "rot": rv_matrix_to_three(struct.unpack_from("<9f", tb, o + 20)),
                        "half": [abs(v) * S for v in struct.unpack_from("<3f", tb, o + 56)],
                        "id": data & 0xFFFF})
                if typ != 0:
                    continue
                piano.append({"pos": C(*struct.unpack_from("<3f", tb, o + 8)),
                              "rot": rv_matrix_to_three(struct.unpack_from("<9f", tb, o + 20)),
                              "half": [abs(v) * S for v in struct.unpack_from("<3f", tb, o + 56)], "data": data})

        sp = inf["STARTPOSREV" if rev else "STARTPOS"]
        return {"start": {"pos": C(*sp), "rot": inf.get("STARTROTREV" if rev else "STARTROT", 0),
                          "grid": int(inf.get("STARTGRIDREV" if rev else "STARTGRID", 0))},
                "zones": zones, "pan": {"start": pstart, "total": ptotal * S, "nodes": nodes},
                "pickups": pickups, "ai": ai, "piano": piano, "signs": signs,
                "splits": sorted(splits, key=lambda t: t["id"]), "throws": throws}

    # skybox (original executable names levels\<name>\sky_{bt,tp,lt,bk,rt,ft}.bmp for Toys in the Hood 1, Ghost
    # Town 1 and both Toytanics; Ghost Town 1's aren't on the disc): six 256 px faces, not colour-keyed
    sky = None
    faces = ["ft", "bk", "lt", "rt", "tp", "bt"]
    if all(files.get(f"sky_{f}.bmp") for f in faces):
        sky = {}
        for f in faces:
            sw, sh, srgb = read_bmp(files[f"sky_{f}.bmp"])
            write(os.path.join(out, f"sky_{f}.png"), png(sw, sh, bytes(c for i in range(0, len(srgb), 3) for c in (*srgb[i:i + 3], 255))), gz=False)
            sky[f] = f"sky_{f}.png"

    track = {
        "name": inf.get("NAME", name),
        **({"sky": sky} if sky else {}),
        "fog": {"color": inf.get("FOGCOLOR", [0, 0, 0]), "start": inf.get("FOGSTART", 5000) * S,
                "far": inf.get("FARCLIP", 10000) * S},
        "geometry": meta,
        "collision": {"triangles": len(tris)},
        "props": props,
        **({"train": train} if train else {}),
        "ambient": ambient_sounds(name, files.get(f"{name}.fob")),
        "mirrors": mirror_planes(files.get(f"{name}.rim"), inf.get("MIRRORS")),
        "fields": force_fields(files.get(f"{name}.fld")),
        **({"objects": objects, "objectModels": object_models} if objects else {}),
        "modelRgbPer": modelper,
        # flag 2: lights the cars as they pass (src/carlight.ts)
        "lights": [L for L in lights if L["flag"] & 2],
        # REDBOOK a b: the CD tracks a+1..b+1 it plays (convert/music.sh rips them to music/trackNN.mp3)
        "music": [int(x) + 1 for x in inf["REDBOOK"]] if isinstance(inf.get("REDBOOK"), list) and inf["REDBOOK"][0] > 0 else [],
        **route(files, False),
    }
    write(os.path.join(out, "track.json"), json.dumps(track, separators=(",", ":")))
    # reversed: same geometry, the route files from reversed/ (missing ones fall back to forward)
    rd = files.get("reversed")
    if rd and os.path.isdir(rd):
        rfiles = {**files, **{f.lower(): os.path.join(rd, f) for f in os.listdir(rd)}}
        rt = {**track, **route(rfiles, True), "reversed": True}
        if rev_geo:
            rt.update({"geometry": rev_geo[0], "bin": "track-rev.bin", "props": rev_geo[1],
                       "colBin": "collision-rev.bin", "collision": {"triangles": len(wtris) + len(rev_geo[2]) + len(otris)}})
        write(os.path.join(out, "track-rev.json"), json.dumps(rt, separators=(",", ":")))
    # the level's picture from the game's track select (gfx/<name>.bmp, 256x256)
    pv = find(f"gfx/{name}.bmp")
    if pv:
        w_, h_, rgb = read_bmp(pv)
        write(os.path.join(out, "preview.png"), png(w_, h_, bytes(c for i in range(0, len(rgb), 3) for c in (*rgb[i:i + 3], 255))), gz=False)
    print(f"{name}: '{track['name']}' world polys {npolys}, instances {ninst}, "
          f"render verts {meta['vertices']}, collision tris {len(tris)}, zones {len(track['zones'])}, nodes {len(track['pan']['nodes'])}, ai nodes {len(track['ai'])}" + (", reversed" if os.path.exists(os.path.join(out, 'track-rev.json')) else ""))


# ---------------------------------------------------------------- cars

def parse_params(path):
    """Parameters.txt -> nested dict. Sections: BODY { }, WHEEL n { } ..."""
    text = open(path, encoding="latin-1").read()
    root = {}
    stack = [root]
    for raw in text.splitlines():
        line = raw.split(";")[0].strip()
        if not line:
            continue
        if line.startswith("}"):
            if len(stack) > 1:
                stack.pop()
            continue
        if line.endswith("{") and line != "{":
            head = line[:-1].split()
            sec = {}
            if len(head) == 2:
                stack[-1].setdefault(head[0].upper(), {})[head[1]] = sec
            else:
                stack[-1][head[0].upper()] = sec
            stack.append(sec)
            continue
        if line == "{":
            continue
        toks = re.findall(r'"[^"]*"|[^\s,]+', line)
        if not toks:
            continue
        key = toks[0].upper()
        vals = []
        for t in toks[1:]:
            if t.startswith('"'):
                vals.append(t.strip('"'))
            elif t.upper() in ("TRUE", "FALSE"):
                vals.append(t.upper() == "TRUE")
            else:
                try:
                    vals.append(float(t))
                except ValueError:
                    vals.append(t)
        if key == "MODEL":
            stack[-1].setdefault("MODEL", {})[int(vals[0])] = vals[1]
        elif key == "INERTIA":
            stack[-1]["INERTIA"] = vals
            stack[-1]["_inertia_rows"] = 1
        elif not vals and False:
            pass
        else:
            # continuation rows of a matrix (only numbers on the line)
            if re.match(r"^-?[\d.]", toks[0]) and "_inertia_rows" in stack[-1]:
                stack[-1]["INERTIA"] += [float(x) for x in toks]
                continue
            stack[-1][key] = vals[0] if len(vals) == 1 else vals
    return root


def hull_points(path):
    b = open(path, "rb").read()
    off = 0
    nh, = struct.unpack_from("<h", b, off)
    off += 2
    pts = []
    for _ in range(nh):
        vc, ec, fc = struct.unpack_from("<3h", b, off)
        off += 6 + 24 + 12
        for k in range(vc):
            pts.append(struct.unpack_from("<3f", b, off + 12 * k))
        off += 12 * vc + 4 * ec + 16 * fc
    return pts


def vec3(v, scale=S):
    return [v[0] * scale, -v[1] * scale, -v[2] * scale]


# Car shadows: gfx/Shadow.bmp holds a top-down shape per car; original executable
# gives each car, in the game's car order, its box (left, right, front, back in cm, original game
# axes) and its cell on that page (x, y, w, h px). Order from the exe's "cars\\<name>" table.
_SHADOW_ROWS = [
    ("rc", -37, 37, 77, -70, 32, 0, 32, 64), ("mite", -37, 37, 81, -79, 224, 0, 32, 64),
    ("phat", -52, 52, 121, -138, 128, 0, 32, 64), ("moss", -40, 40, 85, -90, 160, 0, 32, 64),
    ("mud", -44, 44, 94, -83, 128, 64, 32, 64), ("beatall", -39, 39, 89, -86, 192, 0, 32, 64),
    ("volken", -44, 44, 84, -97, 192, 64, 32, 64), ("tc6", -35, 35, 76, -69, 32, 192, 32, 64),
    ("dino", -45, 45, 76, -92, 96, 0, 32, 64), ("candy", -49, 49, 118, -97, 160, 64, 32, 64),
    ("gencar", -51, 51, 107, -100, 0, 64, 32, 64), ("tc4", -41, 41, 84, -81, 160, 128, 32, 64),
    ("mouse", -64, 64, 132, -119, 96, 64, 32, 64), ("flag", -40, 40, 82, -73, 64, 0, 32, 64),
    ("tc2", -38, 38, 94, -67, 32, 128, 32, 64), ("r5", -34, 34, 56, -74, 0, 0, 32, 64),
    ("tc5", -38, 38, 74, -72, 192, 128, 32, 64), ("sgt", -56, 56, 132, -108, 64, 64, 32, 64),
    ("tc3", -41, 41, 75, -85, 96, 128, 32, 64), ("adeon", -34, 34, 75, -59, 224, 128, 32, 64),
    ("fone", -55, 55, 115, -110, 32, 64, 32, 64), ("tc1", -38, 38, 86, -77, 0, 128, 32, 64),
    ("rotor", -70, 70, 72, -66, 32, 192, 32, 64), ("cougar", -43, 43, 92, -86, 128, 128, 32, 64),
    ("sugo", -37, 37, 82, -68, 0, 192, 32, 64), ("toyeca", -38, 38, 70, -89, 224, 64, 32, 64),
    ("amw", -42, 42, 96, -81, 64, 128, 32, 64), ("panga", -74, 74, 85, -86, 32, 192, 32, 64),
    ("trolley", -82, 82, 198, -177, 64, 128, 32, 64), ("wincar", -28, 28, 47, -42, 32, 192, 32, 64),
    ("wincar2", -28, 28, 41, -44, 32, 192, 32, 64), ("wincar3", -28, 28, 44, -40, 32, 192, 32, 64),
    ("wincar4", -28, 28, 44, -40, 32, 192, 32, 64), ("ufo", -52, 52, 52, -52, 66, 194, 61, 61),
    ("q", -41, 41, 84, -81, 160, 128, 32, 64),
]
SHADOWS = {r[0]: r[1:] for r in _SHADOW_ROWS}


def convert_car(key):
    pfile = find(f"cars/{key}/parameters.txt")
    if not pfile:
        return None
    p = parse_params(pfile)
    models = p.get("MODEL", {})
    out = os.path.join(OUT, "cars", key)

    def model(i):
        m = models.get(i)
        if not m or m == "NONE":
            return None
        return find(m)

    mb_parts = []
    mesh_meta = []
    for part, idx in (("body", 0), ("wheel0", 1), ("wheel1", 2), ("wheel2", 3), ("wheel3", 4)):
        path = model(idx)
        if not path:
            mesh_meta.append(None)
            continue
        polys, verts = read_prm(path)
        mb = MeshBuilder()
        add_polys(mb, polys, verts, lambda v: C(*v), 1.0, tex_map=lambda t: 0 if t >= 0 else -1, env=part == "body")
        data, meta = mb.pack()
        meta["part"] = part
        mb_parts.append(data)
        mesh_meta.append(meta)

    # suspension visuals: SPRING / AXLE / PIN n each name a model number
    extra = {}
    for sec in ("SPRING", "AXLE", "PIN"):
        for i in range(4):
            mn = p.get(sec, {}).get(str(i), {}).get("MODELNUM", -1)
            if not isinstance(mn, float) or mn < 0 or int(mn) in extra:
                continue
            path = model(int(mn))
            if not path:
                continue
            polys, verts = read_prm(path)
            mb = MeshBuilder()
            add_polys(mb, polys, verts, lambda v: C(*v), 1.0, tex_map=lambda t: 0 if t >= 0 else -1)
            data, meta = mb.pack()
            meta["part"] = f"m{int(mn)}"
            mb_parts.append(data)
            mesh_meta.append(meta)
            extra[int(mn)] = len(mesh_meta) - 1

    # the aerial: a whip of SecModelNum sections (cars/misc/Aerial.m, 1 unit long) with a
    # TopModelNum tip (AerialT.m), mounted at Offset, pointing along Direction
    aer = p.get("AERIAL", {})
    for key_ in ("SECMODELNUM", "TOPMODELNUM"):
        mn = aer.get(key_, -1)
        if not isinstance(mn, float) or mn < 0 or int(mn) in extra:
            continue
        path = model(int(mn))
        if not path:
            continue
        polys, verts = read_prm(path)
        mb = MeshBuilder()
        add_polys(mb, polys, verts, lambda v: C(*v), 1.0, tex_map=lambda t: 0 if t >= 0 else -1)
        data, meta = mb.pack()
        meta["part"] = f"m{int(mn)}"
        mb_parts.append(data)
        mesh_meta.append(meta)
        extra[int(mn)] = len(mesh_meta) - 1

    # concatenate parts; each part's layout offsets become absolute
    blob = b""
    for meta, data in zip([m for m in mesh_meta if m], mb_parts):
        base = len(blob)
        meta["layout"] = {k: v + base for k, v in meta["layout"].items()}
        blob += data
        blob += b"\0" * ((-len(blob)) % 4)
    write(os.path.join(out, "car.bin"), blob)

    tp = p.get("TPAGE")
    if key == "trolley" and (not tp or tp.upper() == "NONE"):
        # the shopping trolley has no page of its own: its wire basket (5 faces, page 24) is the level's
        # trolley.bmp — only Supermarket 1 has one, so both supermarkets use it (it was drawn white)
        tp = "levels/market1/trolley.bmp"
    tex = None
    if tp and find(tp):
        texture(find(tp), os.path.join(out, "car.png"))
        tex = "car.png"

    body = p.get("BODY", {})
    wheels = []
    for i in range(4):
        w = p.get("WHEEL", {}).get(str(i))
        if not w:
            continue
        o1 = w.get("OFFSET1", [0, 0, 0])
        o2 = w.get("OFFSET2", [0, 0, 0])
        wheels.append({
            "offset1": vec3(o1), "offset2": vec3(o2),
            "present": w.get("ISPRESENT", True), "powered": w.get("ISPOWERED", False),
            "turnable": w.get("ISTURNABLE", False), "steerRatio": w.get("STEERRATIO", 0.0),
            "engineRatio": w.get("ENGINERATIO", 0.0), "radius": w.get("RADIUS", 10) * S,
            "mass": w.get("MASS", 0.1), "maxPos": w.get("MAXPOS", 8) * S,
            "skidWidth": w.get("SKIDWIDTH", 10) * S, "axleFriction": w.get("AXLEFRICTION", 0.02),
            "grip": w.get("GRIP", 0.015), "staticFriction": w.get("STATICFRICTION", 1.5),
            "kineticFriction": w.get("KINETICFRICTION", 1.4),
        })
    springs = []
    for i in range(4):
        s = p.get("SPRING", {}).get(str(i))
        if not s:
            continue
        springs.append({"offset": vec3(s.get("OFFSET", [0, 0, 0])), "length": s.get("LENGTH", 10) * S,
                        "mesh": extra.get(int(s.get("MODELNUM", -1)), -1),
                        "stiffness": s.get("STIFFNESS", 300), "damping": s.get("DAMPING", 5),
                        "restitution": s.get("RESTITUTION", -0.9)})

    def links(sec):
        out = []
        for i in range(4):
            a = p.get(sec, {}).get(str(i), {})
            out.append({"mesh": extra.get(int(a.get("MODELNUM", -1)), -1), "offset": vec3(a.get("OFFSET", [0, 0, 0])),
                        "length": a.get("LENGTH", 0) * S})
        return out
    axles, pins = links("AXLE"), links("PIN")

    hull = []
    if p.get("COLL") and find(p["COLL"]):
        hull = [vec3(v) for v in hull_points(find(p["COLL"]))]
    inertia = body.get("INERTIA", [1000, 0, 0, 0, 1000, 0, 0, 0, 300])

    car = {
        "key": key,
        "name": p.get("NAME", key),
        "selectable": bool(p.get("SELECTABLE", False)),
        "class": p.get("CLASS", 0), "rating": p.get("RATING", 0),
        "topEnd": p.get("TOPEND", 0), "acc": p.get("ACC", 0), "weight": p.get("WEIGHT", 1),
        "handling": p.get("HANDLING", 0),
        "steerRate": p.get("STEERRATE", 3), "steerMod": p.get("STEERMOD", 0.4),
        "engineRate": p.get("ENGINERATE", 4), "topSpeed": p.get("TOPSPEED", 30),
        "downForceMod": p.get("DOWNFORCEMOD", 2),
        # original executable adds CoM to the body's and every wheel's offset in a frame whose origin is the
        # centre of mass: the centre of mass is at -CoM from the model's centre.
        # It was taken as +CoM — every car's weight front-to-back (and up-down) mirrored: the
        # rear-driven Panga TC had 81% on its front wheels ("unable to go up this grass")
        "com": [-v for v in vec3(p.get("COM", [0, 0, 0]))],
        "body": {"mass": body.get("MASS", 1.0),
                 "inertia": [inertia[0] * S * S, inertia[4] * S * S, inertia[8] * S * S],
                 "resistance": body.get("RESISTANCE", 0.001), "angRes": body.get("ANGRES", 0.001),
                 "resMod": body.get("RESMOD", 25), "grip": body.get("GRIP", 0.01),
                 "staticFriction": body.get("STATICFRICTION", 0.8),
                 "kineticFriction": body.get("KINETICFRICTION", 0.4)},
        "wheels": wheels, "springs": springs, "axles": axles, "pins": pins, "hull": hull,
        "texture": tex, "meshes": mesh_meta,
        # the body's chrome tint (EnvRGB; the game's own default where a car has none)
        "env": [c / 255 for c in (p["ENVRGB"] if isinstance(p.get("ENVRGB"), list) else [200, 200, 200])],
    }
    if key in SHADOWS:
        l, r, f, b, u, v, w, h = SHADOWS[key]
        car["shadow"] = {"box": [l * S, r * S, f * S, b * S], "uv": [u / 256, v / 256, w / 256, h / 256]}
    if aer and extra.get(int(aer.get("SECMODELNUM", -1)), -1) >= 0:
        d = vec3(aer.get("DIRECTION", [0, -1, 0]), 1)
        n = math.sqrt(sum(c * c for c in d)) or 1
        car["aerial"] = {"offset": vec3(aer.get("OFFSET", [0, 0, 0])), "dir": [c / n for c in d],
                         "length": aer.get("LENGTH", 20) * S, "stiffness": aer.get("STIFFNESS", 2000),
                         "damping": aer.get("DAMPING", 5), "sec": extra[int(aer["SECMODELNUM"])],
                         "top": extra.get(int(aer.get("TOPMODELNUM", -1)), -1)}
    write(os.path.join(out, "car.json"), json.dumps(car, separators=(",", ":")))
    return car


def convert_cars():
    index = []
    for key in sorted(os.listdir(find("cars"))):
        if key.lower() == "misc":
            continue
        car = convert_car(key)
        if not car:
            continue
        print(f"car {key}: '{car['name']}' selectable={car['selectable']} hull={len(car['hull'])} "
              f"topEnd={car['topEnd']:.0f} mass={car['body']['mass']}")
        if car["selectable"] and car["meshes"][0]:
            index.append({"key": key, "name": car["name"], "class": car["class"], "rating": car["rating"],
                          "topEnd": car["topEnd"], "acc": car["acc"], "weight": car["weight"],
                          "handling": car["handling"]})
    write(os.path.join(OUT, "cars", "index.json"), json.dumps(index, indent=1))


SOUNDS = {  # out name -> wavs/ file (the original 22 kHz mono effects, copied as-is)
    "moto": "moto.wav", "petrol": "petrol.wav", "clockwork": "clockwrk.wav",
    "skid": "skid_normal.wav", "skid_rough": "skid_rough.wav", "hit": "Hit2.wav", "hit_soft": "hit1.wav",
    "scrape": "scrape.wav", "countdown": "countdown.wav", "horn": "honkgood.wav",
    # weapons
    "pickup": "pickup.wav", "pickgen": "pickgen.WAV", "shockfire": "shockfire.wav", "shock": "shock.wav",
    "firefire": "firefire.wav", "firebang": "firebang.wav", "electro": "electro.wav", "electrozap": "electrozap.wav",
    "oildrop": "oildrop.wav", "wbombfire": "wbombfire.wav", "wbombhit": "wbombhit.wav", "wbombbounce": "wbombbounce.wav",
    "balldrop": "balldrop.wav", "ball": "ball.wav", "fuse": "fuse.wav", "puttbang": "puttbang.wav",
    "turbo": "turbo.wav", "starfire": "starfire.wav", "splash": "splash.wav",
    "piano": "toy/piano.wav", "train": "toy/train.wav", "whistle": "toy/whistle.wav",
    "dragon": "toy/dragon.wav",
}


# + the start countdown: 3, 2, 1, GO (models/go3, go2, go1, gogo — untextured, vertex-coloured)
WEAPON_MODELS = ["pickup", "firework", "wbomb", "ball", "star", "fuse", "sphere", "go3", "go2", "go1", "gogo"]


def convert_weapons():
    """FX texture pages (sprites, HUD icons) + the weapon/pickup models."""
    out = os.path.join(OUT, "fx")
    for k in (1, 2, 3):
        # (an upscale in convert/hd/fx/ replaces it — texture(); the HUD scales its pixel rects by the
        # page's width)
        texture(find(f"gfx/fxpage{k}.bmp"), os.path.join(out, f"fx{k}.png"))
    # the chrome look of the ball bearing: Sphere.m has no texture, the game env-maps it
    texture(find("gfx/envroll.bmp"), os.path.join(out, "envroll.png"))
    texture(find("gfx/envstill.bmp"), os.path.join(out, "envstill.png"))
    # car shadows: grey = how much darker (drawn subtractive), not colour-keyed
    w_, h_, rgb = read_bmp(find("gfx/shadow.bmp"))
    write(os.path.join(out, "shadow.png"), png(w_, h_, bytes(c for i in range(0, len(rgb), 3) for c in (*rgb[i:i + 3], 255))), gz=False)
    blob = b""
    meta = {}
    for m in WEAPON_MODELS:
        polys, verts = read_prm(find(f"models/{m}.m"))
        mb = MeshBuilder()
        add_polys(mb, polys, verts, lambda v: C(*v), 1.0)  # tex index = fx page (0 -> fx1)
        data, mm = mb.pack()
        base = len(blob)
        mm["layout"] = {k: v + base for k, v in mm["layout"].items()}
        for g in mm["groups"]:
            g["texture"] = f"fx{g['tex'] + 1}.png" if g["tex"] >= 0 else None
        blob += data + b"\0" * ((-len(data)) % 4)
        meta[m] = mm
    write(os.path.join(out, "models.bin"), blob)
    write(os.path.join(out, "models.json"), json.dumps(meta, separators=(",", ":")))
    print("weapons: fx pages + models", ", ".join(WEAPON_MODELS))


def convert_hud():
    """HUD art: gfx/Font.bmp (8x16 cells from '!' = 33, 32 per row; the big race
    digits below) and the blue rounded box from gfx/spru.bmp (64x64 cell at 0,0),
    drawn as a 9-slice frame round the panels. Both colour-keyed like the game
    (only pure black is see-through), so the font's grey edge pixels stay and
    give the letters their dark rim; the client tints the font by multiplying."""
    out = os.path.join(OUT, "hud")
    texture(find("gfx/font.bmp"), os.path.join(out, "font.png"))
    w, h, rgb = read_bmp(find("gfx/spru.bmp"))
    cell = bytearray()
    for y in range(64):
        cell += rgb[(y * w) * 3: (y * w + 64) * 3]
    write(os.path.join(out, "frame.png"), png(64, 64, keyed_rgba(64, 64, cell)), gz=False)
    # the loading screen: gfx/loadlevel1-4 are the four 256 px quarters of one blue picture (1 2 / 3 4),
    quarters = [read_bmp(find(f"gfx/loadlevel{k}.bmp")) for k in (1, 2, 3, 4)]
    big = bytearray(512 * 512 * 3)
    for k, (qw, qh, qrgb) in enumerate(quarters):
        ox, oy = (k % 2) * 256, (k // 2) * 256
        for y in range(256):
            big[((oy + y) * 512 + ox) * 3:((oy + y) * 512 + ox + 256) * 3] = qrgb[y * qw * 3:(y * qw + 256) * 3]
    write(os.path.join(out, "loading.png"), png(512, 512, bytes(c for i in range(0, len(big), 3) for c in (*big[i:i + 3], 255))), gz=False)
    # the game's logo: rows 6-68 of gfx/loading.bmp (over black; the rest is demo text) — cut from the
    # user's own game files like everything else here
    lw, lh, lrgb = read_bmp(find("gfx/loading.bmp"))
    logo = lrgb[6 * lw * 3:69 * lw * 3]
    write(os.path.join(out, "logo.png"), png(lw, 63, keyed_rgba(lw, 63, logo)), gz=False)
    # AI-upscaled HUD pages in convert/hd/hud/ (optional, not part of this repository) replace the originals (revhud.ts scales its cells)
    for name in ("font.png", "frame.png", "logo.png", "loading.png"):
        hd = os.path.join(HD, "hud", name)
        if os.path.exists(hd):
            shutil.copyfile(hd, os.path.join(out, name))
    print("hud: font + frame + loading screen")


def convert_sounds():
    for out, src in SOUNDS.items():
        path = find(f"wavs/{src}")
        if not path:
            print("  missing sound", src)
            continue
        write(os.path.join(OUT, "sfx", out + ".wav"), open(path, "rb").read())
    print("sounds:", len(SOUNDS))


if __name__ == "__main__":
    what = sys.argv[1:] or ["toylite", "toy2", "cars", "sounds", "weapons", "hud"]
    for w in what:
        if w == "cars":
            convert_cars()
        elif w == "sounds":
            convert_sounds()
        elif w == "weapons":
            convert_weapons()
        elif w == "hud":
            convert_hud()
        else:
            convert_track(w)
