import { test } from "node:test";
import assert from "node:assert/strict";
import { startRegistrationStream } from "./registration-stream.ts";

type Handler = (payload: any) => void;
type StatusCb = (status: string) => void;

function fakeClient(opts: { removeImpl?: () => Promise<void>; subscribeThrows?: boolean } = {}) {
  const s: { handler?: Handler; status?: StatusCb; removed: number; resolveRemove?: () => void } = {
    removed: 0,
  };
  const channel: any = {
    on(_t: string, _f: unknown, h: Handler) {
      s.handler = h;
      return channel;
    },
    subscribe(cb: StatusCb) {
      if (opts.subscribeThrows) throw new Error("sub boom");
      s.status = cb;
      return channel;
    },
  };
  const client: any = {
    channel: () => channel,
    removeChannel: async () => {
      s.removed++;
      if (opts.removeImpl) return opts.removeImpl();
    },
  };
  return { s, create: (() => client) as any };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ev = (eventType: string, slab?: string, key: "new" | "old" = "new") => ({
  eventType,
  [key]: slab ? { slab_address: slab } : {},
});

function quiet<T>(fn: () => T | Promise<T>) {
  const logs: string[] = [];
  const ol = console.log, ow = console.warn;
  console.log = (...a) => void logs.push(a.join(" "));
  console.warn = (...a) => void logs.push(a.join(" "));
  const restore = () => { console.log = ol; console.warn = ow; };
  return Promise.resolve().then(fn).then(
    (v) => { restore(); return { v, logs }; },
    (e) => { restore(); throw e; },
  );
}

const cfg = (f: any, onChange: any) => ({
  supabaseUrl: "http://x", supabaseAnonKey: "k", onChange, createClient: f.create,
});

test("burst of events coalesces into one onChange with the last event", async () => {
  const f = fakeClient();
  const calls: any[] = [];
  await quiet(async () => {
    const st = startRegistrationStream(cfg(f, (e: any) => calls.push(e)))!;
    f.s.handler!(ev("INSERT", "AAAAAAAAAAAA"));
    f.s.handler!(ev("UPDATE", "BBBBBBBBBBBB"));
    f.s.handler!(ev("DELETE", "CCCCCCCCCCCC", "old"));
    await sleep(400);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { type: "DELETE", slabAddress: "CCCCCCCCCCCC" });
    f.s.handler!(ev("INSERT")); // no row -> null slab
    await sleep(400);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].slabAddress, null);
    await st.stop();
  });
});

test("stop race: event arriving while removeChannel is awaited does not call onChange", async () => {
  let release!: () => void;
  const f = fakeClient({ removeImpl: () => new Promise<void>((r) => (release = r)) });
  const calls: any[] = [];
  await quiet(async () => {
    const st = startRegistrationStream(cfg(f, (e: any) => calls.push(e)))!;
    f.s.handler!(ev("INSERT", "AAAAAAAAAAAA")); // pending timer, cleared by stop
    const p = st.stop();
    f.s.handler!(ev("UPDATE", "BBBBBBBBBBBB")); // arrives mid-removeChannel
    await sleep(400);
    release();
    await p;
    await sleep(400);
    assert.equal(calls.length, 0);
    assert.equal(f.s.removed, 1);
  });
});

test("stop swallows removeChannel rejection", async () => {
  const f = fakeClient({ removeImpl: () => Promise.reject(new Error("x")) });
  await quiet(async () => {
    const st = startRegistrationStream(cfg(f, () => {}))!;
    await st.stop();
  });
});

test("sync throw and async rejection from onChange are caught and logged", async () => {
  const f = fakeClient();
  let n = 0;
  const { logs } = await quiet(async () => {
    const st = startRegistrationStream(
      cfg(f, () => {
        n++;
        if (n === 1) throw new Error("sync-bad");
        if (n === 2) return Promise.reject(new Error("async-bad"));
        if (n === 3) throw "str-bad";
        return Promise.reject("x");
      }),
    )!;
    for (let i = 0; i < 4; i++) {
      f.s.handler!(ev("INSERT", "AAAAAAAAAAAA"));
      await sleep(350);
    }
    await st.stop();
  });
  assert.equal(n, 4);
  assert.ok(logs.some((l) => l.includes("sync-bad")));
  assert.ok(logs.some((l) => l.includes("async-bad")));
  assert.ok(logs.some((l) => l.includes("str-bad")));
});

test("onChange returning non-promise value is fine", async () => {
  const f = fakeClient();
  let n = 0;
  await quiet(async () => {
    const st = startRegistrationStream(cfg(f, () => (n++, 5 as any)))!;
    f.s.handler!(ev("INSERT", "AAAAAAAAAAAA"));
    await sleep(350);
    await st.stop();
  });
  assert.equal(n, 1);
});

test("createClient throwing returns null (Error and non-Error)", async () => {
  for (const thrown of [new Error("boom"), "str"]) {
    const { v, logs } = await quiet(() =>
      startRegistrationStream({
        supabaseUrl: "u", supabaseAnonKey: "k", onChange: () => {},
        createClient: (() => { throw thrown; }) as any,
      }),
    );
    assert.equal(v, null);
    assert.ok(logs[0].includes("could not create client"));
  }
});

test("subscribe throwing returns null (Error and non-Error)", async () => {
  const f = fakeClient({ subscribeThrows: true });
  const { v, logs } = await quiet(() => startRegistrationStream(cfg(f, () => {})));
  assert.equal(v, null);
  assert.ok(logs.some((l) => l.includes("subscribe failed")));
  const f2: any = { create: () => ({ channel: () => { throw "nope"; } }) };
  const r2 = await quiet(() => startRegistrationStream(cfg(f2, () => {})));
  assert.equal(r2.v, null);
});

test("status callback: SUBSCRIBED logs, errors warn, CLOSED warns unless stopped", async () => {
  const f = fakeClient();
  const { logs } = await quiet(async () => {
    const st = startRegistrationStream(cfg(f, () => {}))!;
    f.s.status!("SUBSCRIBED");
    f.s.status!("CHANNEL_ERROR");
    f.s.status!("TIMED_OUT");
    f.s.status!("CLOSED");
    f.s.status!("JOINING"); // ignored
    await st.stop();
    f.s.status!("CLOSED"); // expected on shutdown: silent
  });
  assert.equal(logs.filter((l) => l.includes("push registration active")).length, 1);
  assert.equal(logs.filter((l) => l.includes("CHANNEL_ERROR")).length, 1);
  assert.equal(logs.filter((l) => l.includes("TIMED_OUT")).length, 1);
  assert.equal(logs.filter((l) => l.includes("channel CLOSED")).length, 1);
});

test("default createClient is used when not injected", async () => {
  const { v } = await quiet(() =>
    startRegistrationStream({ supabaseUrl: "not a url", supabaseAnonKey: "", onChange: () => {} }),
  );
  assert.equal(v, null); // supabase-js rejects invalid url -> null, no throw
});

test("payload with neither new nor old row, and onChange returning a non-thenable object", async () => {
  const f = fakeClient();
  const calls: any[] = [];
  await quiet(async () => {
    const st = startRegistrationStream(cfg(f, (e: any) => (calls.push(e), {} as any)))!;
    f.s.handler!({ eventType: "TRUNCATE" });
    await sleep(350);
    await st.stop();
  });
  assert.deepEqual(calls, [{ type: "TRUNCATE", slabAddress: null }]);
});
