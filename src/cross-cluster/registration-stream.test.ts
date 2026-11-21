/**
 * Unit tests for cross-cluster/registration-stream.ts (push registration wake-up).
 *
 * The real supabase-js client is used but its RealtimeChannel `on` / `subscribe`
 * are stubbed on the prototype, so no socket is ever opened.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RealtimeChannel } from "@supabase/supabase-js";
import { startRegistrationStream } from "./registration-stream.ts";

type Handler = (payload: Record<string, unknown>) => void;
type StatusCb = (status: string) => void;

const proto = RealtimeChannel.prototype as unknown as {
  on: unknown;
  subscribe: unknown;
};
const origOn = proto.on;
const origSubscribe = proto.subscribe;

let handler: Handler | null;
let statusCb: StatusCb | null;
let subscribeThrows: Error | string | null;
let logs: string[];
let warns: string[];
const origLog = console.log;
const origWarn = console.warn;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  handler = null;
  statusCb = null;
  subscribeThrows = null;
  logs = [];
  warns = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  proto.on = function (this: unknown, _type: string, _filter: unknown, cb: Handler) {
    handler = cb;
    return this;
  };
  proto.subscribe = function (this: unknown, cb: StatusCb) {
    if (subscribeThrows !== null) throw subscribeThrows;
    statusCb = cb;
    return this;
  };
});

afterEach(() => {
  console.log = origLog;
  console.warn = origWarn;
  proto.on = origOn;
  proto.subscribe = origSubscribe;
});

const cfg = (onChange: (e: { type: string; slabAddress: string | null }) => void) => ({
  supabaseUrl: "http://127.0.0.1:1",
  supabaseAnonKey: "anon-test-key",
  onChange,
});

describe("startRegistrationStream", () => {
  it("returns null and warns when the client cannot be created", () => {
    const s = startRegistrationStream({
      supabaseUrl: "not a url",
      supabaseAnonKey: "k",
      onChange: () => {},
    });
    assert.equal(s, null);
    assert.match(warns.join("\n"), /could not create client/);
  });

  it("returns null and warns when subscribe throws an Error", () => {
    subscribeThrows = new Error("boom");
    const s = startRegistrationStream(cfg(() => {}));
    assert.equal(s, null);
    assert.match(warns.join("\n"), /subscribe failed.*boom/);
  });

  it("stringifies a non-Error subscribe failure", () => {
    subscribeThrows = "plain-string";
    const s = startRegistrationStream(cfg(() => {}));
    assert.equal(s, null);
    assert.match(warns.join("\n"), /subscribe failed.*plain-string/);
  });

  it("logs subscription status transitions", async () => {
    const s = startRegistrationStream(cfg(() => {}));
    assert.ok(s);
    statusCb!("SUBSCRIBED");
    statusCb!("CHANNEL_ERROR");
    statusCb!("TIMED_OUT");
    statusCb!("CLOSED");
    assert.match(logs.join("\n"), /push registration active/);
    assert.equal(warns.filter((w) => /periodic poll still active/.test(w)).length, 2);
    await s.stop();
  });

  it("coalesces a burst into one onChange carrying the latest event", async () => {
    const seen: Array<{ type: string; slabAddress: string | null }> = [];
    const s = startRegistrationStream(cfg((e) => seen.push(e)));
    assert.ok(s);
    handler!({ eventType: "INSERT", new: { slab_address: "AAAAAAAABBBB" } });
    handler!({ eventType: "UPDATE", new: { slab_address: "CCCCCCCCDDDD" } });
    assert.equal(seen.length, 0);
    await sleep(400);
    assert.deepEqual(seen, [{ type: "UPDATE", slabAddress: "CCCCCCCCDDDD" }]);
    assert.match(logs.join("\n"), /INSERT markets AAAAAAAA…/);
    await s.stop();
  });

  it("falls back to payload.old for DELETE and null slab when row is empty", async () => {
    const seen: Array<{ type: string; slabAddress: string | null }> = [];
    const s = startRegistrationStream(cfg((e) => seen.push(e)));
    assert.ok(s);
    handler!({ eventType: "DELETE", old: { slab_address: "OLDSLAB1XYZ" } });
    await sleep(400);
    handler!({ eventType: "UPDATE" });
    await sleep(400);
    assert.deepEqual(seen, [
      { type: "DELETE", slabAddress: "OLDSLAB1XYZ" },
      { type: "UPDATE", slabAddress: null },
    ]);
    await s.stop();
  });

  it("swallows an onChange throw (Error and non-Error) and keeps firing", async () => {
    let n = 0;
    const s = startRegistrationStream(
      cfg(() => {
        n++;
        if (n === 1) throw new Error("cb-err");
        throw "cb-str";
      }),
    );
    assert.ok(s);
    handler!({ eventType: "INSERT", new: {} });
    await sleep(400);
    handler!({ eventType: "INSERT", new: {} });
    await sleep(400);
    assert.equal(n, 2);
    const w = warns.join("\n");
    assert.match(w, /onChange threw: cb-err/);
    assert.match(w, /onChange threw: cb-str/);
    await s.stop();
  });

  it("stop() cancels a pending timer so onChange never fires, and is safe if removeChannel rejects", async () => {
    let fired = 0;
    const s = startRegistrationStream(cfg(() => fired++));
    assert.ok(s);
    handler!({ eventType: "INSERT", new: {} });
    await s.stop();
    await sleep(400);
    assert.equal(fired, 0);
    // second stop: channel already removed; must not throw
    await s.stop();
  });

  it("stop() with no pending timer resolves", async () => {
    const s = startRegistrationStream(cfg(() => {}));
    assert.ok(s);
    await s.stop();
  });
});
