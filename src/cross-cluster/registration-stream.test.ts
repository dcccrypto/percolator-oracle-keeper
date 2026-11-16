/**
 * Pins registration-stream.ts behaviour: coalescing timer, stop(), swallowed
 * errors. The Supabase client is real; only channel()/removeChannel() are
 * replaced on its prototype with a fake channel, and the clock is faked.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/registration-stream.test.ts
 */
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { SupabaseClient } from "@supabase/supabase-js";
import { startRegistrationStream } from "./registration-stream.ts";

type Payload = { eventType: string; new?: unknown; old?: unknown };

let onPayload: ((p: Payload) => void) | null;
let onStatus: ((s: string) => void) | null;
let removed: number;
let removeThrows: boolean;
let subscribeThrows: boolean;
let channelCalls: number;

const cfg = (onChange: (e: { type: string; slabAddress: string | null }) => void) => ({
  supabaseUrl: "http://localhost:54321",
  supabaseAnonKey: "anon",
  onChange,
});

beforeEach(() => {
  onPayload = null;
  onStatus = null;
  removed = 0;
  removeThrows = false;
  subscribeThrows = false;
  channelCalls = 0;
  mock.timers.enable({ apis: ["setTimeout"] });
  mock.method(console, "log", () => {});
  mock.method(console, "warn", () => {});
  const fake: any = {
    on(_t: string, _f: unknown, cb: (p: Payload) => void) {
      onPayload = cb;
      return fake;
    },
    subscribe(cb: (s: string) => void) {
      if (subscribeThrows) throw new Error("boom-subscribe");
      onStatus = cb;
      return fake;
    },
  };
  mock.method(SupabaseClient.prototype, "channel", () => {
    channelCalls++;
    return fake;
  });
  mock.method(SupabaseClient.prototype, "removeChannel", async () => {
    removed++;
    if (removeThrows) throw new Error("boom-remove");
    return "ok";
  });
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

describe("registration-stream", () => {
  it("coalesces a burst into one onChange carrying the latest event", () => {
    const seen: unknown[] = [];
    startRegistrationStream(cfg((e) => seen.push(e)));
    onPayload!({ eventType: "INSERT", new: { slab_address: "AAAAAAAAAAAA" } });
    mock.timers.tick(100);
    onPayload!({ eventType: "UPDATE", new: { slab_address: "BBBBBBBBBBBB" } });
    mock.timers.tick(249);
    assert.equal(seen.length, 0);
    mock.timers.tick(1);
    assert.deepEqual(seen, [{ type: "UPDATE", slabAddress: "BBBBBBBBBBBB" }]);
    // timer cleared after firing: next event schedules a fresh one
    onPayload!({ eventType: "DELETE", old: { slab_address: "CCCCCCCCCCCC" } });
    mock.timers.tick(250);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1], { type: "DELETE", slabAddress: "CCCCCCCCCCCC" });
  });

  it("row without slab_address yields null slab", () => {
    const seen: any[] = [];
    startRegistrationStream(cfg((e) => seen.push(e)));
    onPayload!({ eventType: "INSERT" });
    mock.timers.tick(250);
    assert.equal(seen[0].slabAddress, null);
  });

  it("channel status callbacks (reconnect) never touch the timer or re-subscribe", () => {
    const seen: unknown[] = [];
    startRegistrationStream(cfg((e) => seen.push(e)));
    onPayload!({ eventType: "INSERT", new: {} });
    onStatus!("CHANNEL_ERROR");
    onStatus!("TIMED_OUT");
    onStatus!("SUBSCRIBED");
    assert.equal(channelCalls, 1, "one channel, no double subscription");
    mock.timers.tick(250);
    assert.equal(seen.length, 1, "exactly one onChange, no duplicate timer");
  });

  it("a throwing onChange is swallowed and does not wedge the debounce", () => {
    let n = 0;
    startRegistrationStream(
      cfg(() => {
        n++;
        throw new Error("handler down");
      }),
    );
    onPayload!({ eventType: "INSERT", new: {} });
    mock.timers.tick(250);
    onPayload!({ eventType: "INSERT", new: {} });
    mock.timers.tick(250);
    assert.equal(n, 2, "later events still fire after a handler failure");
  });

  it("stop() cancels a pending timer and removes the channel", async () => {
    const seen: unknown[] = [];
    const s = startRegistrationStream(cfg((e) => seen.push(e)))!;
    onPayload!({ eventType: "INSERT", new: {} });
    await s.stop();
    mock.timers.tick(1000);
    assert.equal(seen.length, 0);
    assert.equal(removed, 1);
    // late event after stop must not fire either
    onPayload!({ eventType: "INSERT", new: {} });
    mock.timers.tick(1000);
    assert.equal(seen.length, 0);
  });

  it("stop() swallows a removeChannel failure", async () => {
    removeThrows = true;
    const s = startRegistrationStream(cfg(() => {}))!;
    await assert.doesNotReject(s.stop());
    assert.equal(removed, 1);
  });

  it("subscribe failure returns null (poll-only fallback)", () => {
    subscribeThrows = true;
    assert.equal(startRegistrationStream(cfg(() => {})), null);
  });

  it("client creation failure returns null", () => {
    assert.equal(
      startRegistrationStream({ supabaseUrl: "", supabaseAnonKey: "", onChange: () => {} }),
      null,
    );
  });
});
