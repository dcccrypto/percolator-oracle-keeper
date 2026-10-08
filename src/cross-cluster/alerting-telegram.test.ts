/**
 * Telegram delivery for the keeper's in-process alerts (stale-price safeguard, 2026-10-08).
 * The existing sink only posted a Slack/Discord-style `{ text }` webhook; the team's alert channel is a Telegram bot,
 * whose sendMessage needs `chat_id`. These tests pin the request shape, dedupe/resolve delivery, env parsing,
 * and that the bot token (it is in the URL) never reaches a log line.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AlertSink,
  DEFAULT_THRESHOLDS,
  TELEGRAM_API_BASE,
  evaluateMarketPush,
  evaluatePushCycle,
  getAlertSink,
  telegramTargetFromEnv,
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
    assert.equal(posts.length, 1, "inside the cooldown: no repeat");
    t += 60_000;
    await sink.reconcile("push", []);
    assert.equal(posts.length, 2);
    assert.match(String(posts[1]!.body.text), /^\[RESOLVED\] percolator-keeper market-no-push WOSE\/USDC: condition cleared/);
  });

  it("webhook and Telegram both deliver when both are configured; one failing does not stop the other", async () => {
    const { sink, posts, logs } = sinkWith({ webhookUrl: "https://hooks.example.com/x", fail: (u) => (u.startsWith("https://hooks") ? new Error("HTTP 500") : null) });
    await sink.reconcile("push", [noPush]);
    assert.equal(posts.length, 1);
    assert.ok(posts[0]!.url.includes("/sendMessage"));
    assert.ok(logs.some((l) => /webhook delivery failed: HTTP 500/.test(l)));
  });

  it("a failing Telegram send never throws and never logs the token, even if the error message contains the URL", async () => {
    const { sink, logs } = sinkWith({ fail: (u) => new Error(`request to ${u} failed, reason: ECONNRESET`) });
    await assert.doesNotReject(sink.reconcile("push", [noPush]));
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
    await sink.reconcile("push", [...zero.active, ...mkt.active]);
    assert.deepEqual(posts.map((p) => String(p.body.text).split(":")[0]), ["[CRITICAL] percolator-keeper zero-pushes *", "[CRITICAL] percolator-keeper market-no-push WOSE/USDC"]);
  });

  it("no Telegram target: nothing is posted", async () => {
    const posts: string[] = [];
    const sink = new AlertSink({ thresholds: DEFAULT_THRESHOLDS, post: async (u) => void posts.push(u), log: () => {}, logError: () => {} });
    await sink.reconcile("push", [noPush]);
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
