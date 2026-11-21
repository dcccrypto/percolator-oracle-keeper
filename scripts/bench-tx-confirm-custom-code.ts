/** Bench customCodeOf. Run: npx tsx scripts/bench-tx-confirm-custom-code.ts (BENCH_MOD=<path> benches another copy) */
const { customCodeOf } = await import(process.env.BENCH_MOD ?? "../src/cross-cluster/tx-confirm.ts");

const N = 200_000;
const inputs: Array<[string, unknown]> = [
  ["object err", { InstructionError: [2, { Custom: 6021 }] }],
  ["string hex err", "Transaction simulation failed: custom program error: 0x1785"],
  ["non-custom err", { InstructionError: [0, "InvalidAccountData"] }],
  ["null", null],
];
let sink = 0;
for (const [name, v] of inputs) {
  for (let i = 0; i < 20_000; i++) sink += customCodeOf(v) ?? 0; // warmup
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) sink += customCodeOf(v) ?? 0;
  const ns = Number(process.hrtime.bigint() - t0) / N;
  console.log(`${name.padEnd(16)} ${ns.toFixed(0)} ns/op`);
}
if (sink === -1) console.log(sink);
