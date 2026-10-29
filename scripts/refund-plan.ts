/**
 * D6 refund PLAN tool (dry-run only: builds and verifies a plan document, never pays anything).
 *   pnpm refund-plan plan   --input never-connected.json [--prior prev-plan.json] --out plan.json
 *   pnpm refund-plan verify --plan plan.json
 * Logic and safety notes: src/cross-cluster/v22/refund-plan.ts.
 */
import { runCli } from "../src/cross-cluster/v22/refund-plan.ts";

process.exitCode = runCli(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s) });
