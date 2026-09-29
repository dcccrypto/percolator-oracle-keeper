/**
 * rpc-headers.ts — Connection config for the devnet RPC, from env.
 *
 * The live devnet Helius key is Origin-restricted: every call 401s
 * "Unauthorized" without the exact Origin header. That header used to live
 * only as an UNCOMMITTED edit to cross-cluster.ts on the live machine, so any
 * fresh checkout (or a second keeper) silently could not talk to devnet.
 * `DEVNET_RPC_ORIGIN` makes it configuration instead.
 */
import type { ConnectionConfig } from "@solana/web3.js";

export function devnetConnectionConfig(env: Readonly<Record<string, string | undefined>>): ConnectionConfig {
  const origin = env.DEVNET_RPC_ORIGIN?.trim();
  if (!origin) return { commitment: "confirmed" };
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    throw new Error(`DEVNET_RPC_ORIGIN="${origin}" is not a URL (expected e.g. https://example.com)`);
  }
  if (u.origin !== origin) {
    throw new Error(`DEVNET_RPC_ORIGIN="${origin}" must be a bare origin (scheme://host[:port]), got path/query`);
  }
  return { commitment: "confirmed", httpHeaders: { Origin: origin } };
}
