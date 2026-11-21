/**
 * Child half of dlmm-depth-zero-price.test.ts. Not named *.test.ts so the dlmm-depth*.test.ts glob never runs it directly
 * (on a regressed base it spins forever). The parent runs it as a plain script in its own process group, starts its 5s clock
 * when this prints READY (tsx start-up alone can take >10s on a loaded box), and SIGKILLs the group if no RESULT follows.
 */
import { createHash } from "node:crypto";
import { planDlmmBinArrays } from "./dlmm-depth.ts";

const b = Buffer.alloc(904);
createHash("sha256").update("account:LbPair").digest().subarray(0, 8).copy(b, 0);
b.writeInt32LE(Number(process.env.ZP_ACTIVE_ID ?? -3000), 76);
b.writeUInt16LE(Number(process.env.ZP_BIN_STEP ?? 10_000), 80);
process.stdout.write("READY\n");
const plan = planDlmmBinArrays(b);
process.stdout.write(`RESULT ${JSON.stringify({ ok: plan.ok })}\n`);
process.exit(0);
