/**
 * cross-cluster/tx-confirm.ts
 *
 * Decide whether a sent transaction LANDED by asking the cluster for its
 * signature status — never by whether `confirmTransaction` happened to return
 * before its block-height deadline.
 *
 * Why (fee-flow audit F6, 2026-09-29): the LP-fee cranker logged SOLCAT
 * `5xq4yAXH…` and ANSEM `4RJv6kJt…` as "block height exceeded" FAILURES, but
 * both had landed OK (the slab counters showed lp_fee_withdrawn == accrued).
 * `confirmTransaction({signature, blockhash, lastValidBlockHeight})` throws
 * `TransactionExpiredBlockheightExceededError` when its websocket/poll loop
 * does not observe the confirmation before the blockhash's last valid block
 * height — which says nothing about whether the transaction executed. The
 * reverse bug was there too: a confirmation that returned `value.err` (the
 * transaction landed but FAILED on chain) was counted as success because the
 * result was never read.
 *
 * The rule here: the signature status is the source of truth.
 *   - status found, err == null, commitment >= confirmed  -> "landed"
 *   - status found, err != null                            -> "failed" (on-chain)
 *   - status not found after the deadline and a re-check   -> "not-landed"
 *     (dropped/expired; safe to retry next cycle — it can no longer land,
 *      because its blockhash is past lastValidBlockHeight)
 */
import type { Connection, SignatureStatus, TransactionError } from "@solana/web3.js";

export type ConfirmOutcome =
  | { status: "landed"; signature: string; via: "confirm" | "signature-status" }
  | { status: "failed"; signature: string; err: TransactionError; code: number | null }
  | { status: "not-landed"; signature: string; reason: string };

/** The subset of Connection this module uses — lets tests stub it precisely. */
export type ConfirmConnection = Pick<Connection, "confirmTransaction" | "getSignatureStatuses">;

export interface ConfirmOptions {
  /** Re-checks of the signature status after confirmTransaction gives up. */
  statusRetries?: number;
  /** Delay between those re-checks. */
  statusRetryDelayMs?: number;
}

/** `{"InstructionError":[i,{"Custom":N}]}` -> N. */
export function customCodeOf(err: unknown): number | null {
  const text = typeof err === "string" ? err : JSON.stringify(err ?? "");
  const dec = text.match(/"Custom"\s*:\s*(\d+)/);
  if (dec) return Number(dec[1]);
  const hex = text.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  return hex ? parseInt(hex[1], 16) : null;
}

function isConfirmed(s: SignatureStatus): boolean {
  return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized";
}

async function readStatus(conn: ConfirmConnection, signature: string): Promise<SignatureStatus | null> {
  const res = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
  return res.value[0] ?? null;
}

/**
 * Wait for `signature` and classify it by its signature status. Never throws:
 * an RPC failure while checking is reported as "not-landed" with the reason,
 * and the caller retries next cycle (every keeper fee instruction is
 * idempotent against its on-chain counters — a second attempt after a landed
 * first one returns the program's "nothing to do" code).
 */
export async function confirmBySignature(
  conn: ConfirmConnection,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
  opts: ConfirmOptions = {},
): Promise<ConfirmOutcome> {
  const retries = opts.statusRetries ?? 3;
  const delayMs = opts.statusRetryDelayMs ?? 2_000;

  let confirmError: string | null = null;
  try {
    const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) {
      return { status: "failed", signature, err: res.value.err, code: customCodeOf(res.value.err) };
    }
    return { status: "landed", signature, via: "confirm" };
  } catch (err) {
    // Expected on a slow confirmation: block height exceeded, or a timeout.
    // Fall through to the signature status, which is what actually decides.
    confirmError = err instanceof Error ? err.message : String(err);
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const s = await readStatus(conn, signature);
      if (s) {
        if (s.err) return { status: "failed", signature, err: s.err, code: customCodeOf(s.err) };
        if (isConfirmed(s)) return { status: "landed", signature, via: "signature-status" };
        // "processed" only: keep polling — it may still be confirmed.
      }
    } catch (err) {
      confirmError = `${confirmError ?? ""} | status read failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
  }
  return {
    status: "not-landed",
    signature,
    reason: `no confirmed signature status (${(confirmError ?? "unknown").slice(0, 120)})`,
  };
}
