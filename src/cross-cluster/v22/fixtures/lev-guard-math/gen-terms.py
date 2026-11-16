import sys, json, random
sys.path.insert(0, "/Users/khubair/agent-work/percolator-ops/sims/v22lev")
import levmodel as L
from types import SimpleNamespace as H
random.seed(7)
kinds = list(L.S_DEFAULT)
out = []
for i in range(800):
    n = random.randint(0, 6)
    hs = []
    for _ in range(n):
        k = random.choice(kinds)
        d = dict(kind=k, frac=random.choice([random.random()*0.3, 0.0, 1e-6, 1.0]))
        if random.random() < .3: d["s"] = random.random()
        if random.random() < .3: d["pi"] = random.choice([0.0, 0.02, 0.5, random.random()*0.05])
        if random.random() < .2: d["individual"] = False
        hs.append(d)
    x = random.choice([random.random()*0.5 + 1e-4, 0.01, 1.0])
    age = random.choice([0, 0.5, 1, 6.9, 7, 29, 30, 400, random.random()*60])
    un = random.random() < .3
    objs = [H(kind=d["kind"], frac=d["frac"], s=d.get("s"), pi=d.get("pi"), individual=d.get("individual", True)) for d in hs]
    J, m, h = L.holder_terms(objs, x, age, un)
    out.append(dict(h=hs, x=x, age=age, un=un, J=J, m=m, H=h, pis={k: L.pi_default(k, age, un) for k in kinds}))
print("H9", L.H9_FULL_SALE, file=sys.stderr)
json.dump(out, open("terms.json", "w"))
