// Verbatim copy of DepthSampleWindow before the perf rewrite (filter-on-every-call). Used only by the differential test.
const DEFAULT_DEPTH_MIN_WINDOW_MS = 30_000;
const DEFAULT_DEPTH_BRACKET_DROP_PCT = 20;
const MAX_SAMPLES_PER_POOL = 64;
type DepthSamplePhase = "pre" | "post";
interface Sample {
  atMs: number;
  reserveE6: bigint;
  phase: DepthSamplePhase;
}

/** The bracketing signature: a sharp drop between a pre-push read and the post-push re-read. */
interface BracketSignal {
  pool: string;
  preReserveE6: bigint;
  postReserveE6: bigint;
  dropPct: number;
}

/**
 * Per-pool short window of quote-reserve samples (USD e6). The attested depth is a monotone function of the reserve
 * (`plus2PctDepthE6`), so the min reserve gives the min depth.
 */
export class LegacyDepthSampleWindow {
  private readonly samples = new Map<string, Sample[]>();
  constructor(
    private readonly windowMs = DEFAULT_DEPTH_MIN_WINDOW_MS,
    dropPct = DEFAULT_DEPTH_BRACKET_DROP_PCT,
  ) {
    // BigInt() throws RangeError on a non-integer, so the threshold is held as integer basis points. A non-finite or
    // negative value falls back to the default rather than throwing inside the push path.
    const pct = Number.isFinite(dropPct) && dropPct >= 0 ? Math.min(dropPct, 100) : DEFAULT_DEPTH_BRACKET_DROP_PCT;
    this.dropBps = BigInt(Math.round(pct * 100));
  }
  private readonly dropBps: bigint;

  record(pool: string, reserveE6: bigint, phase: DepthSamplePhase, atMs: number): void {
    if (reserveE6 < 0n) return;
    const list = this.samples.get(pool) ?? [];
    list.push({ atMs, reserveE6, phase });
    while (list.length > MAX_SAMPLES_PER_POOL) list.shift();
    this.samples.set(pool, list);
    this.prune(pool, atMs);
  }

  private prune(pool: string, nowMs: number): void {
    const list = this.samples.get(pool);
    if (!list) return;
    const kept = list.filter((s) => nowMs - s.atMs <= this.windowMs);
    if (kept.length === 0) this.samples.delete(pool);
    else this.samples.set(pool, kept);
  }

  /** Min reserve over the window, or undefined when the pool has no sample in it. */
  minReserve(pool: string, nowMs: number): bigint | undefined {
    this.prune(pool, nowMs);
    const list = this.samples.get(pool);
    if (!list || list.length === 0) return undefined;
    return list.reduce((m, s) => (s.reserveE6 < m ? s.reserveE6 : m), list[0].reserveE6);
  }

  /**
   * The conservative reserve to attest: min(current read, every sample in the window). An absent current read stays
   * absent (send no depth; never attest from history alone).
   */
  conservative(pool: string, currentE6: bigint | undefined, nowMs: number): bigint | undefined {
    if (currentE6 === undefined) return undefined;
    const m = this.minReserve(pool, nowMs);
    return m !== undefined && m < currentE6 ? m : currentE6;
  }

  /** The latest pre-push sample for a pool within the window. */
  lastPre(pool: string, nowMs: number): bigint | undefined {
    this.prune(pool, nowMs);
    const list = this.samples.get(pool) ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].phase === "pre") return list[i].reserveE6;
    return undefined;
  }

  /** Compare a post-push re-read to the pre-push read; non-null when it dropped by at least `dropPct` percent. */
  detectBracket(pool: string, preE6: bigint, postE6: bigint): BracketSignal | null {
    if (preE6 <= 0n || postE6 >= preE6) return null;
    const dropBps = ((preE6 - postE6) * 10_000n) / preE6;
    if (dropBps < this.dropBps) return null;
    return { pool, preReserveE6: preE6, postReserveE6: postE6, dropPct: Number(dropBps) / 100 };
  }

  /** Test/ops hook. */
  size(pool: string): number {
    return this.samples.get(pool)?.length ?? 0;
  }
}

