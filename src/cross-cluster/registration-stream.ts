/**
 * cross-cluster/registration-stream.ts
 *
 * Push-based market registration over Supabase Realtime.
 *
 * WHY
 * ---
 * The keeper is NAT'd and outbound-only, so the serverless frontend can never
 * reach it. Registration was therefore inverted into an outbound poll of
 * /api/playground/registered-markets. That works, but polling is a latency
 * floor: a market the user just created is not priced until the next tick, and
 * the markets page shows it live in the meantime with its price still at the
 * seed value.
 *
 * Supabase Realtime removes the floor without adding a service to run. The
 * keeper opens ONE outbound WebSocket to Supabase and is told the instant a
 * `markets` row changes. The database is already the authority for which
 * markets exist (the registrations feed is filtered against it), so this is
 * pushing from the same source of truth rather than inventing a second one.
 *
 * WAKE-UP, NOT A DATA SOURCE
 * --------------------------
 * On any change this triggers the normal registration poll rather than reading
 * the payload. Deliberate:
 *
 *   - Admitting a market means checking its on-chain owner, resolving dexType
 *     and poolAddress, and calling addMarket. That logic exists, is tested, and
 *     handles the retired-wrapper case. Duplicating it against a Realtime
 *     payload would be a second path to keep in sync and to get wrong.
 *   - The DB row alone is not enough: it has no dexType, which the keeper needs
 *     to read the mainnet pool. The feed supplies it.
 *   - It is naturally idempotent. Several events for one launch collapse into
 *     one poll, and a duplicate poll is a no-op.
 *
 * The periodic poll stays as the safety net: if the socket drops, is throttled,
 * or Realtime is unavailable, registration still converges on the slower path.
 * This is an optimisation layered on top, never the only route.
 */
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";

export interface RegistrationStreamConfig {
  /** Supabase project URL, e.g. https://xxxx.supabase.co */
  supabaseUrl: string;
  /**
   * Anon key. `markets` has RLS with a public_read SELECT policy, and Realtime
   * enforces RLS per subscriber, so this exposes nothing GET /api/markets does
   * not already serve publicly. Do NOT put a service-role key here.
   */
  supabaseAnonKey: string;
  /** Runs on every observed change. Should be cheap and idempotent. */
  onChange: (event: { type: string; slabAddress: string | null }) => void;
}

/**
 * Debounce window. A single launch writes one row, but a retirement or a
 * backfill can touch many in quick succession; collapsing them into one poll
 * keeps a bulk edit from becoming a burst of identical HTTP requests.
 */
const COALESCE_MS = 250;

export interface RegistrationStream {
  /** Close the socket and stop triggering. */
  stop: () => Promise<void>;
}

/**
 * Subscribe to `markets` changes and invoke `onChange` (coalesced).
 *
 * Never throws: Realtime is an accelerator, and a failure here must not take
 * down price pushing. On any error the caller keeps running on the periodic
 * poll alone.
 */
export function startRegistrationStream(
  config: RegistrationStreamConfig,
): RegistrationStream | null {
  let client: SupabaseClient;
  try {
    client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 10 } },
    });
  } catch (err) {
    console.warn(
      `[registration-stream] could not create client, falling back to polling only: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { type: string; slabAddress: string | null } | null = null;

  const fire = (event: { type: string; slabAddress: string | null }) => {
    pending = event;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const ev = pending;
      pending = null;
      if (!ev) return;
      try {
        config.onChange(ev);
      } catch (err) {
        console.warn(
          `[registration-stream] onChange threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, COALESCE_MS);
  };

  let channel: RealtimeChannel;
  try {
    channel = client
      .channel("keeper-markets")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "markets" },
        (payload) => {
          // REPLICA IDENTITY FULL means a DELETE still carries the old row, so
          // the slab is identifiable either way. Used for logging only — the
          // poll re-derives everything it needs.
          const row = (payload.new ?? payload.old ?? {}) as { slab_address?: string };
          const slabAddress = row.slab_address ?? null;
          console.log(
            `[registration-stream] ${payload.eventType} markets${
              slabAddress ? ` ${slabAddress.slice(0, 8)}…` : ""
            } — triggering registration poll`,
          );
          fire({ type: payload.eventType, slabAddress });
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.log("[registration-stream] subscribed to markets changes (push registration active)");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          // supabase-js reconnects on its own; the periodic poll covers the gap.
          console.warn(`[registration-stream] channel ${status} — periodic poll still active`);
        }
      });
  } catch (err) {
    console.warn(
      `[registration-stream] subscribe failed, falling back to polling only: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  return {
    stop: async () => {
      if (timer) clearTimeout(timer);
      try {
        await client.removeChannel(channel);
      } catch {
        /* shutting down — nothing useful to do */
      }
    },
  };
}
