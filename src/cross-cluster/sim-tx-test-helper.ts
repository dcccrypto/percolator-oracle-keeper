/**
 * Test helper (not a test file): the instructions of a transaction handed to a mocked `simulateTransaction`, whichever
 * shape the code under test passes — a legacy `Transaction` (`.instructions`) or a `VersionedTransaction` (`.message`).
 * The push preflight simulates a VersionedTransaction (perf/v22-keep-1113: no web3.js blockhash refetch); mocks that
 * inspect the pushed instructions read them through this so they keep asserting the same bytes and accounts.
 */
import { TransactionMessage, type TransactionInstruction, type VersionedMessage } from "@solana/web3.js";

export function simInstructions(tx: unknown): TransactionInstruction[] {
  const t = tx as { instructions?: TransactionInstruction[]; message?: VersionedMessage };
  if (Array.isArray(t.instructions)) return t.instructions;
  if (t.message) return TransactionMessage.decompile(t.message).instructions;
  throw new Error("simInstructions: neither a legacy nor a versioned transaction");
}
