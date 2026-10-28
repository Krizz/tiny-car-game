"""A recorded player lap (src/data/laps/<course>.json, shared/laps.ts) as the CPU drivers' racing line.

For every AI node the fastest lap crossed, the node's racing-line point is moved towards where the
lap crossed it (`blend`: 0 = the designers' line, 1 = the player's) and written into the course's
memory as `line` [node, x, z] (src/aidriver.ts); line points already in the memory (hand-set: Museum 2's
rope posts) win, so run it on the memory without an earlier lap's line. The designers' slow-down / lift-off
hints on the nodes the lap went through go into `nohint` (`--hints` keeps them). Prints which way the lap
took at each fork; fork choices (`avoid`) and jumps (`jumps`) are set by hand after testing.
  docker run --rm -v $PWD/src:/src -w /src python:3.12-slim \\
    python test/fromlap.py garden1 data/laps/garden1.json public/game/garden1/ai-garden1.json 0.6
A lap of the forward course can stand in for the mirrored one (`--mirror`: x flipped) — the course is
the same, mirrored. Botanical Garden (2026-10-15): 0.6 beat 0.4, 0.8 and 1 (at 1 the cars missed the
gap's jump; at 0.4/0.8 more resets in races)."""
import json, sys

args = [a for a in sys.argv[1:] if not a.startswith('--')]
course, lapfile, memfile = args[:3]
blend = float(args[3]) if len(args) > 3 else 0.6
level, _, var = course.partition(':')
ai = json.load(open(f'public/game/{level}/track{"-rev" if "r" in var else ""}.json'))['ai']
if 'm' in var:  # as mirrorInfo() in shared/course.ts
    for n in ai:
        n['a'][0] = -n['a'][0]
        n['b'][0] = -n['b'][0]
lap = min(json.load(open(lapfile))['laps'], key=lambda l: l['ms'])
pts = [(q[1] / 100 * (-1 if '--mirror' in sys.argv else 1), q[2] / 100, q[3] / 100) for q in lap['pts']]


def crossing(p, q, a, b):
    """Where along gate a-b the step p-q crosses it (0..1), seen from above, at about its height."""
    x1, z1, x2, z2, x3, z3, x4, z4 = p[0], p[2], q[0], q[2], a[0], a[2], b[0], b[2]
    d = (x1 - x2) * (z3 - z4) - (z1 - z2) * (x3 - x4)
    if abs(d) < 1e-9:
        return None
    t = ((x1 - x3) * (z3 - z4) - (z1 - z3) * (x3 - x4)) / d
    u = -((x1 - x2) * (z1 - z3) - (z1 - z2) * (x1 - x3)) / d
    if 0 <= t <= 1 and 0 <= u <= 1 and abs(p[1] + (q[1] - p[1]) * t - (a[1] + (b[1] - a[1]) * u)) < 3:
        return u
    return None


seen = {}
for p, q in zip(pts, pts[1:]):
    for j, n in enumerate(ai):
        if j not in seen:
            u = crossing(p, q, n['a'], n['b'])
            if u is not None:
                seen[j] = u
# --near: a gate the lap went past without crossing (Supermarket 2 RM, 2026-10-16: the lap ran straight
# along the top of the last bend, beyond the ends of gates 31, 32, 83, 82): its end nearest the lap, when
# the lap passes within NEAR m of it at about its height
NEAR = 8
if '--near' in sys.argv:
    for j, n in enumerate(ai):
        if j in seen:
            continue
        ax, az, bx, bz = n['a'][0], n['a'][2], n['b'][0], n['b'][2]
        L2 = (bx - ax) ** 2 + (bz - az) ** 2 or 1e-9
        best = None
        for p in pts:
            u = max(0.0, min(1.0, ((p[0] - ax) * (bx - ax) + (p[2] - az) * (bz - az)) / L2))
            gx, gz, gy = ax + (bx - ax) * u, az + (bz - az) * u, n['a'][1] + (n['b'][1] - n['a'][1]) * u
            d = ((p[0] - gx) ** 2 + (p[2] - gz) ** 2) ** 0.5
            if abs(p[1] - gy) < 3 and d < NEAR and (best is None or d < best[0]):
                best = (d, u)
        if best:
            seen[j] = best[1]
            print(f"  node {j}: passed {best[0]:.1f} m from its gate, line at {best[1]:.2f}")
mem = json.load(open(memfile))
# --drop=4,5,6 (or --drop=all): hand-set line points of those nodes give way to the lap's
drop = next((a[7:] for a in sys.argv if a.startswith('--drop=')), '')
if drop:
    mem['line'] = [r for r in mem.get('line', []) if drop != 'all' and r[0] not in {int(x) for x in drop.split(',')}]
hand = {r[0]: r for r in mem.get('line', [])}
mem['line'] = [r for i, r in hand.items() if i not in seen]
for j, u in sorted(seen.items()):
    n = ai[j]
    f = n['line'] + (u - n['line']) * blend
    if j in hand:
        mem['line'].append(hand[j])
        continue
    mem['line'].append([j, round(n['a'][0] + (n['b'][0] - n['a'][0]) * f, 2), round(n['a'][2] + (n['b'][2] - n['a'][2]) * f, 2)])
# the designers' hints (slow down 4/16/17/18, lift off 13/14) on nodes the lap went through: not for us
# (`--hints` keeps them)
if '--hints' not in sys.argv:
    mem['nohint'] = sorted(j for j in seen if ai[j]['prio'] in (4, 13, 14, 16, 17, 18))
json.dump(mem, open(memfile, 'w'))
print(f"{lap['car']} {lap['ms'] / 1000:.2f} s: {len(mem['line'])} line points, {len(mem.get('nohint', []))} hints dropped")
for i, n in enumerate(ai):
    if len(n['next']) > 1:
        took = [w for w, j in enumerate(n['next']) if j in seen]
        # (both: the ways' first gates lie on top of each other — look further along, e.g. at a plot)
        print(f"  fork {i}: crossed the first gate of way {took if took else '?'} of {n['next']}")
