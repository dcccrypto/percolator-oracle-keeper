// Bench: node --import tsx/esm scripts/bench/push-depth-isqrt.ts
import { plus2PctDepthE6, isqrt } from "../../src/cross-cluster/push-depth.ts";
let s = 0x9e3779b97f4a7c15n;
const rnd = () => (s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n));
const real: bigint[] = [], huge: bigint[] = [];
for (let i = 0; i < 100_000; i++) {
  real.push(1_000_000n + (rnd() % (10n ** 15n - 1_000_000n)));
  huge.push((rnd() << 32n) | (rnd() >> 32n)); // up to ~2^96
}
function bench(name: string, f: (x: bigint) => unknown, xs: bigint[]) {
  for (let i = 0; i < 20000; i++) f(xs[i]);
  let best = Infinity;
  for (let r = 0; r < 5; r++) {
    const t = process.hrtime.bigint();
    for (const x of xs) f(x);
    best = Math.min(best, Number(process.hrtime.bigint() - t) / xs.length);
  }
  console.log(`${name.padEnd(28)} ${best.toFixed(0)} ns/call`);
}
bench("plus2PctDepthE6 realistic", plus2PctDepthE6, real);
bench("plus2PctDepthE6 huge(2^96)", plus2PctDepthE6, huge);
bench("isqrt realistic^2", isqrt, real.map((x) => x * x));
bench("isqrt huge^2", isqrt, huge.map((x) => x * x));
