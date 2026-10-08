/**
 * Telegram delivery for the keeper's in-process alerts (stale-price safeguard, 2026-10-08).
 * The existing sink only posted a Slack/Discord-style `{ text }` webhook; the team's alert channel is a Telegram bot,
 * whose sendMessage needs `chat_id`. These tests pin the request shape, dedupe/resolve delivery, env parsing,
 * and that the bot token (it is in the URL) never reaches a log line.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AlertSink,
  DEFAULT_THRESHOLDS,
  TELEGRAM_API_BASE,
  TELEGRAM_QUEUE_CAP,
  TELEGRAM_REPEAT_MS,
  evaluateMarketPush,
  evaluatePushCycle,
  getAlertSink,
  telegramTargetFromEnv,
  telegramTargetOrOff,
} from "./alerting.ts";
import type { Alert } from "./alerting.ts";

const TOKEN = "123456789:AAH-secret_TOKEN_value";
const CHAT = "-1001234567890";

function sinkWith(opts: { webhookUrl?: string; fail?: (url: string) => Error | null; now?: () => number } = {}) {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const sink = new AlertSink({
    thresholds: DEFAULT_THRESHOLDS,
    webhookUrl: opts.webhookUrl,
    telegram: { botToken: TOKEN, chatId: CHAT },
    post: async (url, body) => {
      const err = opts.fail?.(url) ?? null;
      if (err) throw err;
      posts.push({ url, body: JSON.parse(body) as Record<string, unknown> });
    },
    now: opts.now ?? (() => 1_000_000),
    log: (l) => logs.push(l),
    logError: (l) => logs.push(l),
  });
  return { sink, posts, logs };
}

const noPush: Alert = { kind: "market-no-push", severity: "critical", subject: "WOSE/USDC", message: "no price push landed for 40 consecutive cycles" };

describe("alerting: Telegram delivery", () => {
  it("posts sendMessage with chat_id and the same text the webhook gets", async () => {
    const { sink, posts } = sinkWith();
    await sink.reconcile("push", [noPush]);
    await sink.flush();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.url, `${TELEGRAM_API_BASE}/bot${TOKEN}/sendMessage`);
    assert.equal(TELEGRAM_API_BASE, "https://api.telegram.org");
    assert.equal(posts[0]!.body.chat_id, CHAT);
    assert.equal(posts[0]!.body.text, "[CRITICAL] percolator-keeper market-no-push WOSE/USDC: no price push landed for 40 consecutive cycles");
  });

  it("one alert per incident (cooldown) and one RESOLVED when it clears", async () => {
    let t = 1_000_000;
    const { sink, posts } = sinkWith({ now: () => t });
    await sink.reconcile("push", [noPush]);
    t += 60_000;
    await sink.reconcile("push", [noPush]);
    await sink.flush();
    assert.equal(posts.length, 1, "inside the cooldown: no repeat");
    t += 60_000;
    await sink.reconcile("push", []);
    await sink.flush();
    assert.equal(posts.length, 2);
    assert.match(String(posts[1]!.body.text), /^\[RESOLVED\] percolator-keeper market-no-push WOSE\/USDC: condition cleared/);
  });

  it("webhook and Telegram both deliver when both are configured; one failing does not stop the other", async () => {
    const { sink, posts, logs } = sinkWith({ webhookUrl: "https://hooks.example.com/x", fail: (u) => (u.startsWith("https://hooks") ? new Error("HTTP 500") : null) });
    await sink.reconcile("push", [noPush]);
    await sink.flush();
    assert.equal(posts.length, 1);
    assert.ok(posts[0]!.url.includes("/sendMessage"));
    assert.ok(logs.some((l) => /webhook delivery failed: HTTP 500/.test(l)));
  });

  it("a failing Telegram send never throws and never logs the token, even if the error message contains the URL", async () => {
    const { sink, logs } = sinkWith({ fail: (u) => new Error(`request to ${u} failed, reason: ECONNRESET`) });
    await assert.doesNotReject(sink.reconcile("push", [noPush]));
    await assert.doesNotReject(sink.flush());
    const line = logs.find((l) => l.includes("telegram delivery failed"));
    assert.ok(line, "the failure is logged");
    for (const l of logs) assert.ok(!l.includes(TOKEN) && !l.includes("secret_TOKEN"), `token leaked: ${l}`);
  });

  it("the stale-push conditions it carries: keeper-wide zero pushes and one market not pushed", async () => {
    const { sink, posts } = sinkWith();
    const zero = evaluatePushCycle({ cycle: 50, registered: 70, attempted: 70, pushed: 0 }, DEFAULT_THRESHOLDS.zeroPushCycles - 1, DEFAULT_THRESHOLDS);
    const mkt = evaluateMarketPush(
      { label: "WOSE/USDC", market: "46Hitb3q", noPushCycles: DEFAULT_THRESHOLDS.marketNoPushCycles, lastPushAt: null, lastError: "no pool price", markGap: null, sourceUnchangedSince: null, terminal: false },
      DEFAULT_THRESHOLDS,
    );
    await sink.reconcile("push", zero.active);
    await sink.reconcile("push-market", mkt.active);
    await sink.flush();
    assert.deepEqual(posts.map((p) => String(p.body.text).split(":")[0]), ["[CRITICAL] percolator-keeper zero-pushes *"], "market-no-push is not paged while zero-pushes is active");
    await sink.reconcile("push", []); // board recovers; WOSE alone still stale
    await sink.reconcile("push-market", mkt.active);
    await sink.flush();
    assert.deepEqual(posts.slice(1).map((p) => String(p.body.text).split(":")[0]), ["[RESOLVED] percolator-keeper zero-pushes *"],
      "inside its 15-min cooldown the market alert is not re-delivered anywhere");
  });

  it("no Telegram target: nothing is posted", async () => {
    const posts: string[] = [];
    const sink = new AlertSink({ thresholds: DEFAULT_THRESHOLDS, post: async (u) => void posts.push(u), log: () => {}, logError: () => {} });
    await sink.reconcile("push", [noPush]);
    await sink.flush();
    assert.deepEqual(posts, []);
  });
});

describe("alerting: telegramTargetFromEnv", () => {
  it("unset is off; both set is on", () => {
    assert.equal(telegramTargetFromEnv({}), undefined);
    assert.equal(telegramTargetFromEnv({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: " ", KEEPER_ALERT_TELEGRAM_CHAT_ID: "" }), undefined);
    assert.deepEqual(telegramTargetFromEnv({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: TOKEN, KEEPER_ALERT_TELEGRAM_CHAT_ID: CHAT }), { botToken: TOKEN, chatId: CHAT });
    assert.deepEqual(telegramTargetFromEnv({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: TOKEN, KEEPER_ALERT_TELEGRAM_CHAT_ID: "@percolator_ops" })?.chatId, "@percolator_ops");
  });
  it("one without the other, or garbage, stops boot without echoing the value", () => {
    assert.throws(() => telegramTargetFromEnv({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: TOKEN }), (e: Error) => /set together/.test(e.message) && !e.message.includes("secret"));
    assert.throws(() => telegramTargetFromEnv({ KEEPER_ALERT_TELEGRAM_CHAT_ID: CHAT }), /set together/);
    assert.throws(() => telegramTargetFromEnv({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: "not a token SECRET", KEEPER_ALERT_TELEGRAM_CHAT_ID: CHAT }), (e: Error) => /not a bot token/.test(e.message) && !e.message.includes("SECRET"));
    assert.throws(() => telegramTargetFromEnv({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: TOKEN, KEEPER_ALERT_TELEGRAM_CHAT_ID: "chat SECRET" }), (e: Error) => /chat id/.test(e.message) && !e.message.includes("SECRET"));
  });
});

describe("alerting: the process-wide sink reads the Telegram env", () => {
  it("getAlertSink() delivers to Telegram when both env vars are set (fetch stubbed, nothing leaves the process)", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const realFetch = globalThis.fetch;
    process.env.KEEPER_ALERT_TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.KEEPER_ALERT_TELEGRAM_CHAT_ID = CHAT;
    delete process.env.KEEPER_ALERT_WEBHOOK_URL;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response("{\"ok\":true}", { status: 200 });
    }) as typeof fetch;
    try {
      await getAlertSink().reconcile("push-env-test", [noPush]);
      await getAlertSink().flush();
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.KEEPER_ALERT_TELEGRAM_BOT_TOKEN;
      delete process.env.KEEPER_ALERT_TELEGRAM_CHAT_ID;
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    assert.equal(seen[0]!.body.chat_id, CHAT);
  });
});

describe("alerting: Telegram is a pager (security review 2026-10-08)", () => {
  it("sends never block the loop: 71 alerts against a stalled Telegram return at once; the queue caps with one log line", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const logs: string[] = [];
    const sink = new AlertSink({
      thresholds: DEFAULT_THRESHOLDS,
      telegram: { botToken: TOKEN, chatId: CHAT },
      post: async (url) => { started.push(url); await gate; },
      now: () => 1_000_000,
      log: () => {},
      logError: (l) => logs.push(l),
    });
    const alerts: Alert[] = Array.from({ length: 71 }, (_, i) => ({ ...noPush, subject: `M${i}` }));
    const t0 = Date.now();
    await sink.reconcile("push-market", alerts);
    assert.ok(Date.now() - t0 < 200, `reconcile blocked ${Date.now() - t0} ms`);
    assert.equal(started.length, 1, "one send in flight at a time");
    const full = logs.filter((l) => l.includes("telegram queue full"));
    assert.equal(full.length, 1, "one collapse line, not 51");
    release();
    await sink.flush();
    assert.equal(started.length, TELEGRAM_QUEUE_CAP);
    assert.ok(logs.some((l) => /queue drained; 51 message\(s\) were dropped/.test(l)));
  });

  it("only critical alerts page; warn (source-frozen) stays in the log", async () => {
    const { sink, posts } = sinkWith();
    await sink.reconcile("push-market", [{ kind: "source-frozen", severity: "warn", subject: "X", message: "frozen" }]);
    await sink.reconcile("push-market", []);
    await sink.flush();
    assert.deepEqual(posts, [], "no warn page, and no RESOLVED for something never paged");
  });

  it("an active alert re-pages at most every 2 h, though the log/webhook cooldown is 15 min", async () => {
    let t = 1_000_000;
    const { sink, posts, logs } = sinkWith({ now: () => t, webhookUrl: "https://hooks.example.com/x" });
    const tg = () => posts.filter((p) => p.url.includes("/sendMessage")).length;
    await sink.reconcile("push-market", [noPush]); await sink.flush();
    assert.equal(tg(), 1);
    for (let i = 0; i < 7; i++) { t += DEFAULT_THRESHOLDS.cooldownMs; await sink.reconcile("push-market", [noPush]); }
    await sink.flush();
    assert.equal(tg(), 1, "105 min: still one page");
    assert.ok(logs.filter((l) => l.startsWith("[ALERT] ")).length >= 8, "the log still repeats on the 15-min cooldown");
    t += DEFAULT_THRESHOLDS.cooldownMs; // 120 min
    await sink.reconcile("push-market", [noPush]); await sink.flush();
    assert.equal(tg(), 2);
    assert.equal(TELEGRAM_REPEAT_MS, 7_200_000);
  });

  it("a typo'd or half-set Telegram env starts the keeper with Telegram off and one error line (no value echoed)", () => {
    const logs: string[] = [];
    assert.equal(telegramTargetOrOff({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: "typo SECRET-VALUE" , KEEPER_ALERT_TELEGRAM_CHAT_ID: CHAT }, (l) => logs.push(l)), undefined);
    assert.equal(telegramTargetOrOff({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: TOKEN }, (l) => logs.push(l)), undefined);
    assert.equal(logs.length, 2);
    for (const l of logs) { assert.match(l, /Telegram alerts OFF/); assert.ok(!l.includes("SECRET") && !l.includes(TOKEN)); }
    assert.deepEqual(telegramTargetOrOff({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: TOKEN, KEEPER_ALERT_TELEGRAM_CHAT_ID: CHAT }, (l) => logs.push(l)), { botToken: TOKEN, chatId: CHAT });
    assert.equal(logs.length, 2);
  });

  it("getAlertSink() with a half-set env does not throw (boot survives), in a fresh process", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", "-e",
      `import(${JSON.stringify(pathToFileURL(path.join(here, "alerting.ts")).href)}).then((m) => { const s = m.getAlertSink(); console.log("BOOT_OK telegram=" + s.telegramEnabled); })`],
      { env: { ...process.env, KEEPER_ALERT_TELEGRAM_BOT_TOKEN: "typo SECRET-VALUE", KEEPER_ALERT_TELEGRAM_CHAT_ID: "" }, encoding: "utf8", cwd: path.join(here, "..", "..") });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /BOOT_OK telegram=false/);
    assert.match(r.stderr, /Telegram alerts OFF/);
    assert.ok(!r.stdout.includes("SECRET") && !r.stderr.includes("SECRET"));
  });
});
