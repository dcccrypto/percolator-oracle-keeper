/**
 * Should this boot count itself as a launch? The launcher's preflight may already have recorded it (<=120 s ago).
 * Used by cross-cluster.ts at startup.
 */
export function shouldRecordLaunch(lastLaunchAgoSec: number | null): boolean {
  return lastLaunchAgoSec === null || lastLaunchAgoSec > 120;
}
