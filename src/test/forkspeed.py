# forkspeed.py <out.jsonl> [--write] : test/forkspeed.ts lines -> which alternative branches are faster.
# Compared on the stretch from the fork to where the branches rejoin (mean over the laps): `fast` when
# the alternative is >= 0.25 s quicker there for every car tried, with no more resets; `fastTurbo` when
# that holds only with a turbo fired at the fork (both branches boosted). --write puts them into
# public/game/<level>/ai-<course>.json (and the mirrored course's).
import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip().startswith('{')]
by = collections.defaultdict(dict)  # (course, fork) -> car -> {kind: row}
for r in rows:
    if r['fork'] < 0: continue
    kind = ('turbo-' if r['turbo'] else '') + ('alt' if r['flip'] else 'main')
    by[(r['course'], r['fork'])].setdefault(r['car'], {})[kind] = r
sec = lambda r: sum(r['sections']) / len(r['sections']) if r and r.get('sections') else None
def gain(k, a, b):
    m, x = k.get(a), k.get(b)
    if sec(m) is None or sec(x) is None or x['resets'] > m['resets']: return None
    return sec(m) - sec(x)
fast = collections.defaultdict(list); fastTurbo = collections.defaultdict(list)
for (course, fork), cars in sorted(by.items()):
    g = [gain(k, 'main', 'alt') for k in cars.values()]
    tg = [gain(k, 'turbo-main', 'turbo-alt') for k in cars.values()]
    G = min(g) if g and None not in g else None
    TG = min(tg) if tg and None not in tg else None
    tag = ''
    if G is not None and G >= 0.25: fast[course].append(fork); tag = 'FAST'
    elif TG is not None and TG >= 0.25: fastTurbo[course].append(fork); tag = 'FAST WITH TURBO'
    print(f'{course:14} fork {fork:3}  alt saves {"-" if G is None else f"{G:+.2f}"} s  with turbo {"-" if TG is None else f"{TG:+.2f}"} s  {tag}')
print('fast', dict(fast)); print('fastTurbo', dict(fastTurbo))
if '--write' in sys.argv:
    for course in sorted({c for c, _ in by}):
        level = course.split(':')[0]
        for c in (course, course + 'm' if ':' in course else course + ':m'):
            f = f'public/game/{level}/ai-{c.replace(":", "-")}.json'
            try: m = json.load(open(f))
            except FileNotFoundError: continue
            m['fast'] = fast.get(course, []); m['fastTurbo'] = fastTurbo.get(course, [])
            json.dump(m, open(f, 'w'), separators=(',', ':'))
            print('wrote', f, m['fast'], m['fastTurbo'])
