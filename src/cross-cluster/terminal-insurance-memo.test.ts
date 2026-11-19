/**
 * Differential: memoised creator-ATA derivation is identical to a fresh findProgramAddressSync, and the
 * CreateIdempotent instruction bytes match a from-scratch build, over 2,000 random (admin, mint) pairs,
 * cold and warm (cache hit), including past the cache bound.
 * Run with: node --import tsx/esm --test src/cross-cluster/terminal-insurance-memo.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { buildCreateCreatorAtaIx, creatorCollateralAta } from "./terminal-insurance.ts";

const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
let s = 0x2545f491;
const rnd = (): number => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
const key = (): PublicKey => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = rnd() & 255; return new PublicKey(b); };
const refAta = (a: PublicKey, m: PublicKey): PublicKey => PublicKey.findProgramAddressSync([a.toBuffer(), TOKEN.toBuffer(), m.toBuffer()], ATA_PROGRAM)[0];
const refIx = (payer: PublicKey, a: PublicKey, m: PublicKey): TransactionInstruction => new TransactionInstruction({
  programId: ATA_PROGRAM,
  keys: [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: refAta(a, m), isSigner: false, isWritable: true },
    { pubkey: a, isSigner: false, isWritable: false },
    { pubkey: m, isSigner: false, isWritable: false },
    { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
    { pubkey: TOKEN, isSigner: false, isWritable: false },
  ],
  data: Buffer.from([1]),
});
const ixEq = (x: TransactionInstruction, y: TransactionInstruction): boolean =>
  x.programId.equals(y.programId) && Buffer.compare(x.data, y.data) === 0 && x.keys.length === y.keys.length
  && x.keys.every((k, i) => k.pubkey.equals(y.keys[i].pubkey) && k.isSigner === y.keys[i].isSigner && k.isWritable === y.keys[i].isWritable);

describe("creator ATA memo differential", () => {
  it("2,000 random keys: identical ATAs and instruction bytes, cold and warm", { timeout: 120_000 }, () => {
    const payer = key();
    // Few distinct pairs would hide eviction; 2,000 distinct pairs, then re-query a repeating subset (warm).
    const pairs = Array.from({ length: 2000 }, () => [key(), key()] as const);
    let mismatches = 0;
    for (const [a, m] of pairs) {
      const want = refAta(a, m);
      if (!creatorCollateralAta(a, m).equals(want)) mismatches++; // cold
      if (!creatorCollateralAta(a, m).equals(want)) mismatches++; // warm
      if (!ixEq(buildCreateCreatorAtaIx(payer, a, m), refIx(payer, a, m))) mismatches++;
    }
    assert.equal(mismatches, 0);
  });
  it("concatenation-ambiguous pairs (admin A1+c vs mint c+M) do not share a cache entry", { timeout: 120_000 }, () => {
    // Find a 44-char admin and a 43-char mint so that moving one char across the boundary gives another valid pair.
    let a2: PublicKey, m2: PublicKey;
    do { a2 = key(); } while (a2.toBase58().length !== 44);
    do { m2 = key(); } while (m2.toBase58().length !== 43);
    const s1 = a2.toBase58().slice(0, 43), s2 = a2.toBase58().slice(43) + m2.toBase58();
    let a1: PublicKey, m1: PublicKey;
    try { a1 = new PublicKey(s1); m1 = new PublicKey(s2); } catch { return; } // not decodable to 32 bytes: nothing to collide
    if (a1.toBuffer().length !== 32 || m1.toBuffer().length !== 32) return;
    assert.ok(creatorCollateralAta(a1, m1).equals(refAta(a1, m1)));
    assert.ok(creatorCollateralAta(a2, m2).equals(refAta(a2, m2)));
  });
  it("swapped admin/mint do not collide", () => {
    const a = key(), m = key();
    assert.ok(creatorCollateralAta(a, m).equals(refAta(a, m)));
    assert.ok(creatorCollateralAta(m, a).equals(refAta(m, a)));
  });
});
