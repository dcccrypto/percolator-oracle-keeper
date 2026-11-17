/**
 * cross-cluster/health-file.ts
 *
 * Optional: mirror the /health body to a file so someone without network access to the health port can read it
 * (the v2.2 fresh-devnet keeper binds 127.0.0.1; QA is remote and reads the ops ledger files).
 *
 *   KEEPER_HEALTH_FILE       absolute path of the JSON file (unset = feature off, nothing is written)
 *   KEEPER_HEALTH_FILE_MS    write interval, default 30000 (minimum 5000)
 *
 * The file holds `{ writtenAt, source, health }` where `health` is exactly the /health JSON. It is written to a
 * temp file in the same directory and renamed, so a reader never sees a partial file. A failed read or write keeps
 * the previous file and never throws into the keeper. /health carries no secrets (addresses, counters, statuses).
 */
import fs from "node:fs";
import path from "node:path";

const MAX_TIMER_MS = 2_147_483_647;
/** A readHealth that has not settled after this long is abandoned so the next tick can run. */
const READ_TIMEOUT_MS = 15_000;

export interface HealthFileConfig {
  file: string;
  intervalMs: number;
}

/** null = feature off. Throws on a relative path or a bad interval (a config mistake should be loud at boot). */
export function healthFileConfigFromEnv(env: Readonly<Record<string, string | undefined>>): HealthFileConfig | null {
  const file = env.KEEPER_HEALTH_FILE?.trim();
  if (!file) return null;
  if (!path.isAbsolute(file)) throw new Error(`KEEPER_HEALTH_FILE must be an absolute path, got "${file}"`);
  const raw = env.KEEPER_HEALTH_FILE_MS?.trim();
  if (raw !== undefined && raw !== "" && !/^\d+$/.test(raw)) throw new Error(`KEEPER_HEALTH_FILE_MS="${raw}" must be a positive integer`);
  // Node clamps any timer delay above 2^31-1 to 1 ms, which would turn a huge value into a write every millisecond.
  return { file, intervalMs: Math.min(MAX_TIMER_MS, Math.max(5_000, raw ? Number(raw) : 30_000)) };
}

/** Write one snapshot. Returns true when the file was replaced. Never throws. */
export async function writeHealthSnapshot(readHealth: () => Promise<string>, file: string, source: string, now: () => Date = () => new Date()): Promise<boolean> {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const health: unknown = JSON.parse(await readHealth());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ writtenAt: now().toISOString(), source, health }, null, 1));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    return false;
  }
}

/** Start the periodic mirror. Returns a stop function. */
export function startHealthFileMirror(cfg: HealthFileConfig, readHealth: () => Promise<string>, source: string): () => void {
  let busy = false;
  const tick = (): void => {
    if (busy) return;
    busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guarded = (): Promise<string> =>
      Promise.race([
        readHealth(),
        new Promise<string>((_, rej) => {
          timer = setTimeout(() => rej(new Error("readHealth timed out")), READ_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    void writeHealthSnapshot(guarded, cfg.file, source).finally(() => {
      clearTimeout(timer);
      busy = false;
    });
  };
  const t = setInterval(tick, cfg.intervalMs);
  t.unref?.();
  setTimeout(tick, 5_000).unref?.();
  return () => clearInterval(t);
}
