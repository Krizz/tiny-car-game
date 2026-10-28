"""Top-down picture of a sim.ts TRACE: the AI nodes' track width (grey), racing line (blue),
the car's path coloured by speed (red slow .. green fast) and resets (magenta crosses).
  docker run --rm -v $PWD/convert:/app:ro -v $PWD/src/test/out:/o python:3.12-slim \
    python /o/../plot.py /o/trace.json /o/trace.png [x0 z0 x1 z1]"""
import json, sys
sys.path.insert(0, "/app")
from convert import png

d = json.load(open(sys.argv[1]))
ai, tr = d["ai"], d["trace"]
pts = [n["a"] for n in ai] + [n["b"] for n in ai]
if len(sys.argv) > 6:
    x0, z0, x1, z1 = map(float, sys.argv[3:7])
else:
    x0, x1 = min(p[0] for p in pts) - 5, max(p[0] for p in pts) + 5
    z0, z1 = min(p[2] for p in pts) - 5, max(p[2] for p in pts) + 5
W = 1400
sc = W / max(x1 - x0, z1 - z0)
w, h = int((x1 - x0) * sc) + 1, int((z1 - z0) * sc) + 1
img = bytearray([255, 255, 255, 255] * w * h)

def put(x, z, c, r=0):
    px, py = int((x - x0) * sc), int((z - z0) * sc)
    for dx in range(-r, r + 1):
        for dy in range(-r, r + 1):
            X, Y = px + dx, py + dy
            if 0 <= X < w and 0 <= Y < h:
                i = (Y * w + X) * 4
                img[i:i + 4] = bytes((*c, 255))

def line(a, b, c, r=0):
    n = int(max(abs(a[0] - b[0]), abs(a[1] - b[1])) * sc) + 1
    for k in range(n + 1):
        t = k / n
        put(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, c, r)

for n in ai:  # the node's span across the track
    line((n["a"][0], n["a"][2]), (n["b"][0], n["b"][2]), (205, 205, 205))
def lp(n, f):
    return (n["a"][0] + (n["b"][0] - n["a"][0]) * f, n["a"][2] + (n["b"][2] - n["a"][2]) * f)
for n in ai:
    for j in n["next"]:
        m = ai[j]
        line(lp(n, n["line"]), lp(m, m["line"]), (60, 90, 230), 1)
vmax = max(p[2] for p in tr) or 1
for a, b in zip(tr, tr[1:]):
    k = max(0, min(1, abs(a[2]) / vmax))
    line((a[0], a[1]), (b[0], b[1]), (int(230 * (1 - k)), int(200 * k), 30), 1)
for x, z in d.get("crashes", []):  # orange dots
    put(x, z, (255, 140, 0), 3)
for x, z in d.get("resets", []):
    for k in range(-6, 7):
        put(x + k / sc, z + k / sc, (220, 0, 220), 1)
        put(x + k / sc, z - k / sc, (220, 0, 220), 1)
open(sys.argv[2], "wb").write(png(w, h, bytes(img)))
print(w, h, "scale px/m", round(sc, 2))
