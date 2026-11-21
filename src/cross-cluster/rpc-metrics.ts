/**
 * cross-cluster/rpc-metrics.ts — per-method RPC call counters for the keeper's two Helius endpoints.
 *
 * WHY HERE: web3.js's `Connection` funnels EVERY request (including the implicit ones:
 * confirmTransaction polling, simulate preflight, and each of the 429 retries of its rate-limit
 * loop) through the `fetch` handed to its constructor. Counting at that seam counts HTTP requests
 * actually sent, which is what a provider bills, not what the keeper's code "meant" to send.
 *
 * Observability only: it never alters the request, the response, or the error.
 *
 * Exposed on /health as `rpc`: per endpoint and method, calls in the trailing 60 s ("perMinute"),
 * the trailing 5 min mean in calls/s ("perSecond5m"), totals since boot, and 429 responses.
 */

export type RpcEndpointLabel = "devnet" | "mainnet";

const WINDOW_SECONDS = 300;

interface MethodWindow {
  /** Calls per absolute second, ring-indexed by `second % WINDOW_SECONDS`. */
  buckets: Uint32Array;
  /** The absolute second each ring slot currently holds (a stale slot is zero). */
  stamps: Float64Array;
  total: number;
  rateLimited: number;
  failed: number;
}

function newWindow(): MethodWindow {
  return { buckets: new Uint32Array(WINDOW_SECONDS), stamps: new Float64Array(WINDOW_SECONDS), total: 0, rateLimited: 0, failed: 0 };
}

const METHOD_RE = /"method"\s*:\s*"([A-Za-z0-9_]+)"/g;

/** JSON-RPC method names in a request body (single request or batch). Never throws. */
export function methodsOfBody(body: unknown): string[] {
  if (typeof body !== "string") return ["<non-string-body>"];
  const out: string[] = [];
  // Every match starts with the literal `"method"`; a body without it (or the tail after the last
  // hit) is rejected by indexOf without running the regex engine over a large payload.
  const first = body.indexOf('"method"');
  if (first < 0) return ["<unknown>"];
  const batch = body.charCodeAt(0) === 91;
  METHOD_RE.lastIndex = first;
  let m: RegExpExecArray | null;
  while ((m = METHOD_RE.exec(body)) !== null) {
    out.push(m[1]);
    // A single request names its method once, before `params`; stop so a base64 payload can never
    // produce a phantom match. Only a batch (leading "[") has several.
    if (!batch) break;
  }
  return out.length > 0 ? out : ["<unknown>"];
}

export class RpcMetrics {
  private readonly windows = new Map<RpcEndpointLabel, Map<string, MethodWindow>>();
  /** Insertion order across endpoints, so snapshot() key order matches the old flat `ep:method` map. */
  private readonly ordered: { ep: RpcEndpointLabel; method: string; w: MethodWindow }[] = [];
  constructor(private readonly now: () => number = Date.now) {}

  private win(endpoint: RpcEndpointLabel, method: string): MethodWindow {
    let byMethod = this.windows.get(endpoint);
    if (!byMethod) {
      byMethod = new Map();
      this.windows.set(endpoint, byMethod);
    }
    let w = byMethod.get(method);
    if (!w) {
      w = newWindow();
      byMethod.set(method, w);
      this.ordered.push({ ep: endpoint, method, w });
    }
    return w;
  }

  /** Record one HTTP request. `status` is the response status, or 0 when the fetch itself threw. */
  record(endpoint: RpcEndpointLabel, method: string, status: number): void {
    const w = this.win(endpoint, method);
    const sec = Math.floor(this.now() / 1000);
    const i = sec % WINDOW_SECONDS;
    if (w.stamps[i] !== sec) {
      w.stamps[i] = sec;
      w.buckets[i] = 0;
    }
    w.buckets[i]++;
    w.total++;
    if (status === 429) w.rateLimited++;
    if (status === 0) w.failed++;
  }

  /**
   * Calls in the trailing 60 s and 300 s in one pass over the ring. Each slot maps to exactly one
   * absolute second in the 300 s range, so `stamp > nowSec - N` (and <= nowSec) is the same test as
   * the per-second walk it replaces.
   */
  private sums(w: MethodWindow, nowSec: number): [number, number] {
    const { stamps, buckets } = w;
    const lo60 = nowSec - 59;
    const lo300 = nowSec - WINDOW_SECONDS + 1;
    let n60 = 0;
    let n300 = 0;
    for (let i = 0; i < WINDOW_SECONDS; i++) {
      const s = stamps[i];
      if (s < lo300 || s > nowSec) continue;
      n300 += buckets[i];
      if (s >= lo60) n60 += buckets[i];
    }
    return [n60, n300];
  }

  snapshot(): {
    perMinute: Record<string, Record<string, number>>;
    perSecond5m: Record<string, Record<string, number>>;
    totals: Record<string, Record<string, number>>;
    rateLimited: Record<string, Record<string, number>>;
    failed: Record<string, Record<string, number>>;
    totalPerMinute: Record<string, number>;
  } {
    const out = {
      perMinute: {} as Record<string, Record<string, number>>,
      perSecond5m: {} as Record<string, Record<string, number>>,
      totals: {} as Record<string, Record<string, number>>,
      rateLimited: {} as Record<string, Record<string, number>>,
      failed: {} as Record<string, Record<string, number>>,
      totalPerMinute: {} as Record<string, number>,
    };
    const put = (bucket: Record<string, Record<string, number>>, ep: string, method: string, v: number): void => {
      (bucket[ep] ??= {})[method] = v;
    };
    const nowSec = Math.floor(this.now() / 1000);
    for (const { ep, method, w } of this.ordered) {
      const [last60, last300] = this.sums(w, nowSec);
      put(out.perMinute, ep, method, last60);
      put(out.perSecond5m, ep, method, Math.round((last300 / WINDOW_SECONDS) * 100) / 100);
      put(out.totals, ep, method, w.total);
      if (w.rateLimited > 0) put(out.rateLimited, ep, method, w.rateLimited);
      if (w.failed > 0) put(out.failed, ep, method, w.failed);
      out.totalPerMinute[ep] = (out.totalPerMinute[ep] ?? 0) + last60;
    }
    return out;
  }
}

/** Process-wide counters (one keeper process, two endpoints). */
export const rpcMetrics = new RpcMetrics();

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * A `fetch` for `new Connection(url, { fetch })` that counts each HTTP request by JSON-RPC method.
 * Because web3.js calls this once per attempt, its 429 retries are counted as the separate
 * requests they are.
 */
export function countingFetch(
  endpoint: RpcEndpointLabel,
  metrics: RpcMetrics = rpcMetrics,
  base: FetchLike = (input, init) => fetch(input, init),
): FetchLike {
  return async (input, init) => {
    const methods = methodsOfBody(init?.body);
    let res: Response;
    try {
      res = await base(input, init);
    } catch (err) {
      for (const m of methods) metrics.record(endpoint, m, 0);
      throw err;
    }
    for (const m of methods) metrics.record(endpoint, m, res.status);
    return res;
  };
}
