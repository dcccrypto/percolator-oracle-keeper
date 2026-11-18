/**
 * s16acEngineDeployed cache + clock behaviour. A backwards wall-clock step (NTP correction, VM resume) made the cached
 * age negative, so `t - at < ttl` stayed true and a stale 'other' answer outlived the upgrade to an S1-6 a/c build.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readElfPrefix, S16acGateState, s16acEngineDeployed } from "./s16ac-engine-gate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const S16AC = new Uint8Array(fx("wrapper-elf4096-rc-s16ac-ddd5a2fa"));
const OTHER = new Uint8Array(fx("wrapper-elf4096-rc-357fc23f"));
const PROGRAM = Keypair.generate().publicKey;
const PROGRAM_DATA = Keypair.generate().publicKey;

function fakeConn(elf: { bytes: Uint8Array | null; throws?: boolean }) {
  return {
    getAccountInfo: async (k: PublicKey) => {
      if (elf.throws) throw new Error("rpc down");
      if (k.equals(PROGRAM)) return { data: Buffer.concat([Buffer.alloc(4), PROGRAM_DATA.toBuffer()]) } as never;
      return elf.bytes ? ({ data: Buffer.from(elf.bytes) } as never) : null;
    },
  };
}

const HOUR = 3_600_000;
const TTL = 60_000;

describe("s16acEngineDeployed clock", () => {
  it("a backwards clock step does not pin a stale 'other' answer past the ttl", async () => {
    const elf: { bytes: Uint8Array | null } = { bytes: OTHER };
    const conn = fakeConn(elf);
    const st = new S16acGateState();
    let t = 10 * HOUR;
    const now = () => t;
    assert.equal((await s16acEngineDeployed(conn, PROGRAM, st, TTL, now)).state, "other");
    t -= HOUR; // clock steps back 1 h
    elf.bytes = S16AC; // wrapper upgraded
    const r = await s16acEngineDeployed(conn, PROGRAM, st, TTL, now);
    assert.equal(r.state, "s16ac");
    assert.equal(r.on, true);
  });

  it("still serves the cache inside the ttl and re-reads after it", async () => {
    const elf: { bytes: Uint8Array | null } = { bytes: OTHER };
    const conn = fakeConn(elf);
    const st = new S16acGateState();
    let t = 1000;
    const now = () => t;
    await s16acEngineDeployed(conn, PROGRAM, st, TTL, now);
    elf.bytes = S16AC;
    t += TTL - 1;
    assert.equal((await s16acEngineDeployed(conn, PROGRAM, st, TTL, now)).state, "other");
    t += 1;
    assert.equal((await s16acEngineDeployed(conn, PROGRAM, st, TTL, now)).state, "s16ac");
  });

  it("unknown (rpc error) is never cached", async () => {
    const elf = { bytes: S16AC as Uint8Array | null, throws: true };
    const conn = fakeConn(elf);
    const st = new S16acGateState();
    assert.deepEqual(await s16acEngineDeployed(conn, PROGRAM, st, TTL, () => 5), { on: false, state: "unknown" });
    elf.throws = false;
    assert.deepEqual(await s16acEngineDeployed(conn, PROGRAM, st, TTL, () => 6), { on: true, state: "s16ac" });
  });

  it("uses Date.now by default", async () => {
    const st = new S16acGateState();
    const r = await s16acEngineDeployed(fakeConn({ bytes: S16AC }), PROGRAM, st, TTL);
    assert.equal(r.state, "s16ac");
    assert.ok(st.value && Math.abs(st.value.at - Date.now()) < 5000);
  });
});

describe("readElfPrefix", () => {
  it("null when the program is missing, short, or ProgramData is missing", async () => {
    assert.equal(await readElfPrefix({ getAccountInfo: async () => null }, PROGRAM), null);
    assert.equal(await readElfPrefix({ getAccountInfo: async () => ({ data: Buffer.alloc(10) }) as never }, PROGRAM), null);
    assert.equal(await readElfPrefix(fakeConn({ bytes: null }), PROGRAM), null);
  });
});
