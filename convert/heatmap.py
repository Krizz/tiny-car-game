# render.py <level> : heat/<level>*.json -> heat/<level>.png (2x2: forward, reversed, mirrored, both)
import json, sys, os, math
import numpy as np
from PIL import Image, ImageDraw, ImageFont
lv = sys.argv[1]
W = 760  # panel width px
names = [('', 'forward'), (':r', 'reversed'), (':m', 'mirrored'), (':rm', 'reversed + mirrored')]
def colormap(t):  # 0..1 -> rgba (transparent blue -> cyan -> yellow -> red)
    stops = [(0, (0, 0, 120, 0)), (0.15, (0, 90, 255, 150)), (0.4, (0, 230, 230, 200)), (0.7, (255, 230, 0, 230)), (1, (255, 40, 0, 255))]
    for (a, ca), (b, cb) in zip(stops, stops[1:]):
        if t <= b:
            f = (t - a) / (b - a)
            return tuple(int(ca[k] + (cb[k] - ca[k]) * f) for k in range(4))
    return stops[-1][1]
lut = np.array([colormap(i / 255) for i in range(256)], dtype=np.uint8)
def panel(path, label):
    d = json.load(open(path))
    x0, x1, z0, z1 = d['box']; R = d['res']
    nx, nz = int(round((x1 - x0) / R)), int(round((z1 - z0) / R))
    hm = np.array(d['hm'], dtype=np.float32)[: nx * nz].reshape(nz, nx)
    valid = hm > -900
    lo, hi = np.percentile(hm[valid], 2), np.percentile(hm[valid], 98)
    g = np.clip((hm - lo) / max(0.5, hi - lo), 0, 1)
    # hill shade from the height gradient, so walls and kerbs show
    gy, gx = np.gradient(np.where(valid, hm, lo))
    shade = np.clip(0.75 - (gx - gy) * 0.9, 0.25, 1.0)
    base = (40 + g * 120) * shade
    rgb = np.stack([base * 0.95, base * 0.97, base], -1)
    rgb[~valid] = (28, 14, 18)
    img = Image.fromarray(rgb.astype(np.uint8), 'RGB').convert('RGBA')
    # density of car positions on the same grid, blurred, log-scaled
    pts = np.array(d['pts'], dtype=np.float32).reshape(-1, 2)
    H = np.zeros((nz, nx), np.float32)
    ix = ((pts[:, 0] - x0) / R).astype(int); iz = ((pts[:, 1] - z0) / R).astype(int)
    ok = (ix >= 0) & (ix < nx) & (iz >= 0) & (iz < nz)
    np.add.at(H, (iz[ok], ix[ok]), 1)
    k = np.exp(-np.arange(-4, 5) ** 2 / 4.0); k /= k.sum()
    for ax in (0, 1): H = np.apply_along_axis(lambda m: np.convolve(m, k, mode='same'), ax, H)
    Hn = np.log1p(H) / max(1e-6, np.log1p(np.percentile(H[H > 0], 99.5)))
    heat = lut[(np.clip(Hn, 0, 1) * 255).astype(np.uint8)]
    heat[H < 0.02] = 0
    img = Image.alpha_composite(img, Image.fromarray(heat, 'RGBA'))
    s = W / nx
    img = img.resize((W, int(nz * s)), Image.BILINEAR)
    dr = ImageDraw.Draw(img)
    P = lambda x, z: ((x - x0) / R * s, (z - z0) / R * s)
    c = d['crashes']
    for i in range(0, len(c), 2):
        x, y = P(c[i], c[i + 1]); dr.ellipse([x - 2.5, y - 2.5, x + 2.5, y + 2.5], fill=(255, 255, 255, 230))
    r = d['resets']
    for i in range(0, len(r), 2):
        x, y = P(r[i], r[i + 1]); dr.line([x - 5, y - 5, x + 5, y + 5], fill=(0, 255, 255), width=2); dr.line([x - 5, y + 5, x + 5, y - 5], fill=(0, 255, 255), width=2)
    font = ImageFont.load_default(size=18)
    txt = f"{d['course']}  ({label})  finished {d['finished']}/6  crashes {len(c)//2}  resets {len(r)//2}"
    dr.rectangle([0, 0, W, 28], fill=(0, 0, 0, 170)); dr.text((8, 4), txt, fill=(255, 255, 255), font=font)
    return img
panels = []
for suf, label in names:
    p = f"/w/{lv}{suf.replace(':', '_')}.json"
    if os.path.exists(p): panels.append(panel(p, label))
h = max(p.size[1] for p in panels)
sheet = Image.new('RGBA', (W * 2 + 6, h * 2 + 6), (10, 10, 10, 255))
for i, p in enumerate(panels): sheet.paste(p, ((i % 2) * (W + 6), (i // 2) * (h + 6)))
sheet.convert('RGB').save(f'/w/{lv}.png', optimize=True)
print('wrote', lv, sheet.size)
