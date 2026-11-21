"""Lift recorded v2.2 portfolios (wrapper VERSION 19, kind 2, 10,603 B, engine disc 19) to the engine #299 layout:
insert 4 zero bytes (loss_provenance = LOSS_PROVENANCE_NONE) at account byte 10,475 and stamp disc 20 at byte 114.
Usage: python3 -I lift_disc20.py [--write] <fixture dir>...   (prints every file/field it would change)"""
import base64, json, os, struct, sys

MAGIC = 0x5045_5243_5631_3600
def lift(b: bytes):
    if len(b) != 10603 or b[10] != 2: return None
    if struct.unpack_from('<Q', b, 0)[0] != MAGIC or struct.unpack_from('<H', b, 8)[0] != 19: return None
    if struct.unpack_from('<H', b, 114)[0] != 19: return None
    out = bytearray(b[:10475]) + b'\0\0\0\0' + b[10475:]
    struct.pack_into('<H', out, 114, 20)
    return bytes(out)

def walk(o, path, hits):
    if isinstance(o, dict):
        for k in list(o): o[k] = walk(o[k], f"{path}.{k}", hits)
    elif isinstance(o, list):
        for i in range(len(o)): o[i] = walk(o[i], f"{path}[{i}]", hits)
    elif isinstance(o, str) and len(o) > 14000:
        try: b = base64.b64decode(o, validate=True)
        except Exception: return o
        n = lift(b)
        if n is not None:
            hits.append((path, o, base64.b64encode(n).decode())); return o
    return o

write = '--write' in sys.argv
total = 0
for d in [a for a in sys.argv[1:] if a != '--write']:
    for root, _, files in os.walk(d):
        for f in sorted(files):
            p = os.path.join(root, f)
            if f.endswith('.b64'):
                raw = open(p).read().strip()
                n = lift(base64.b64decode(raw))
                if n is not None:
                    total += 1; print('b64 ', p)
                    if write:
                        nl = open(p).read().endswith('\n')
                        open(p, 'w').write(base64.b64encode(n).decode() + ('\n' if nl else ''))
            elif f.endswith('.json'):
                txt = open(p).read()
                j = json.loads(txt); hits = []
                j = walk(j, '$', hits)
                if hits:
                    total += len(hits); print('json', p, len(hits), [h[0] for h in hits][:6])
                    if write:
                        for _, old, new in hits:
                            assert txt.count(old) >= 1
                            txt = txt.replace(old, new)
                        open(p, 'w').write(txt)
print('total', total)
