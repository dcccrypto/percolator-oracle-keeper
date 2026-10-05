/**
 * cross-cluster/tick-publisher.ts — publish landed marks + raw pool prices to the
 * chart tick service (wire contract v1).
 *
 * OFF by default: with TICK_INGEST_URL or TICK_INGEST_KEY unset the publisher is a
 * no-op and the keeper behaves exactly as before. It never touches chain state.
 *
 * SAFETY: publish() is synchronous from the caller's view, never throws, never
 * awaits network I/O on the caller's path, and keeps at most ONE request in
 * flight (a batch arriving while one is in flight is dropped and counted).
 */

export const TICK_MAX_PER_REQUEST = 200;
const DEFAULT_TIMEOUT_MS = 1500;
const LOG_EVERY_MS = 60_000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The bearer key travels in this request, so the URL must be https. Plain http is accepted ONLY for
 * loopback hosts (local development). Throws at startup (same fail-fast style as env-utils.ts) with a
 * message that never contains the key or the URL's path/query.
 */
export function validateTickIngestUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("TICK_INGEST_URL is not a valid URL");
  }
  if (u.protocol === "https:") return raw;
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return raw;
  throw new Error(
    `TICK_INGEST_URL must be https (http is allowed only for localhost); got ${u.protocol}//${u.hostname}`,
  );
}

export interface TickInput {
  marketAddress: string;
  assetIndex: number;
  /** Published (breaker-accepted) AuthMark, E6. */
  markE6: bigint;
  /** Raw pool price, E6; null / <= 0 when unavailable. */
  oracleE6: bigint | null;
}

export interface WireTick {
  slab: string;
  assetIndex: number;
  slot: number;
  landedMs: number;
  markE6: string;
  oracleE6: string | null;
}

export interface TickBody {
  v: 1;
  src: "keeper";
  sentMs: number;
  ticks: WireTick[];
}

/** Pure: landed inputs -> request bodies of at most TICK_MAX_PER_REQUEST ticks. */
export function buildTickBodies(
  inputs: ReadonlyArray<TickInput>,
  slot: bigint | number,
  landedMs: number,
  sentMs: number,
): TickBody[] {
  const slotNum = Number(slot);
  const ticks: WireTick[] = [];
  for (const i of inputs) {
    if (i.markE6 <= 0n) continue;
    ticks.push({
      slab: i.marketAddress,
      assetIndex: i.assetIndex,
      slot: slotNum,
      landedMs,
      markE6: i.markE6.toString(10),
      oracleE6: i.oracleE6 !== null && i.oracleE6 > 0n ? i.oracleE6.toString(10) : null,
    });
  }
  const bodies: TickBody[] = [];
  for (let k = 0; k < ticks.length; k += TICK_MAX_PER_REQUEST) {
    bodies.push({ v: 1, src: "keeper", sentMs, ticks: ticks.slice(k, k + TICK_MAX_PER_REQUEST) });
  }
  return bodies;
}

export interface TickPublisherCounters {
  enabled: boolean;
  sent: number;
  dropped: number;
  failed: number;
  lastOkMs: number | null;
}

export interface TickPublisher {
  readonly enabled: boolean;
  publish(inputs: ReadonlyArray<TickInput>, slot: bigint | number, landedMs: number): void;
  counters(): TickPublisherCounters;
}

export interface TickPublisherOptions {
  url?: string;
  key?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

export function createTickPublisher(opts: TickPublisherOptions = {}): TickPublisher {
  const url = (opts.url ?? process.env.TICK_INGEST_URL ?? "").trim();
  const key = (opts.key ?? process.env.TICK_INGEST_KEY ?? "").trim();
  const rawTimeout = opts.timeoutMs ?? Number(process.env.TICK_PUBLISH_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const enabled = url !== "" && key !== "";
  // Fail closed at startup: never send the bearer key over a non-https link.
  if (url !== "") validateTickIngestUrl(url);
  const c: TickPublisherCounters = { enabled, sent: 0, dropped: 0, failed: 0, lastOkMs: null };
  let inFlight = false;
  let lastLogAt = 0;

  const noteFailure = (what: string): void => {
    c.failed++;
    const t = now();
    if (t - lastLogAt >= LOG_EVERY_MS) {
      lastLogAt = t;
      log(`[tick-publisher] publish failed (${what}); failed=${c.failed} dropped=${c.dropped}`);
    }
  };

  const send = async (bodies: TickBody[]): Promise<void> => {
    try {
      for (const body of bodies) {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ ...body, sentMs: now() }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          noteFailure(`HTTP ${res.status}`);
          return;
        }
        c.sent += body.ticks.length;
        c.lastOkMs = now();
      }
    } catch (err) {
      noteFailure(err instanceof Error ? err.name : "error");
    } finally {
      inFlight = false;
    }
  };

  return {
    enabled,
    counters: () => ({ ...c }),
    publish(inputs, slot, landedMs) {
      if (!enabled) return;
      try {
        const bodies = buildTickBodies(inputs, slot, landedMs, now());
        if (bodies.length === 0) return;
        if (inFlight) {
          c.dropped += bodies.reduce((n, b) => n + b.ticks.length, 0);
          return;
        }
        inFlight = true;
        void send(bodies);
      } catch {
        inFlight = false;
        c.failed++;
      }
    },
  };
}
