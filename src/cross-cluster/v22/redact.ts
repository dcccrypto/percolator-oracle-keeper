/**
 * cross-cluster/v22/redact.ts
 *
 * Error text from the RPC / fetch stack can embed the request URL, including `?api-key=<secret>`. v2.2 error text
 * reaches logs AND `/health` (`jobs.*.lastError`, `layoutProblems`), and /health binds 0.0.0.0 with no auth (#205),
 * so every v2.2 string goes through this redactor first.
 *
 * GH#225: the path is dropped as well as the query. Helius carries its key in the query
 * (`?api-key=`), but Alchemy (`/v2/<key>`), QuickNode (`/<token>/`), Ankr (`/solana/<key>`) and
 * Triton (`/<key>`) all carry it in the PATH, so keeping `url.pathname` published the credential
 * verbatim. Host and scheme are enough to identify an endpoint in a log; no path segment of an RPC
 * URL is diagnostic enough to be worth a secret.
 */
export function redactErrorText(s: string, max = 160): string {
  return s
    // Header / bearer forms: undici and proxies echo `Authorization: Bearer <t>` / `x-api-key: <k>` in some errors.
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer ***")
    .replace(/\b(x-api-key|api-key|authorization|x-auth-token)\s*:\s*[^\s"',;)]+(?:\s+[^\s"',;)]+)?/gi, "$1: ***")
    .replace(/(api[-_]?key|apikey|token|secret|auth|key|password|passwd|pwd)=[^&\s"')]+/gi, "$1=***")
    // Any scheme, not just http(s)/ws(s): `postgres://user:pass@host/db` (a DB / pooler URL), `redis://`, `ftp://` carry
    // credentials the same way. ws(s) too: web3.js derives its websocket endpoint (same host, same path key) from the RPC URL.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'),]+/gi, (u) => {
      try {
        const url = new URL(u);
        return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : "/***"}${url.search ? "?***" : ""}`;
      } catch {
        return "<url>";
      }
    })
    // A scheme-less `host.tld/<long token>` (some HTTP clients print the target without its scheme).
    .replace(/\b((?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?)\/[^\s"')]*[A-Za-z0-9_-]{16,}[^\s"')]*/gi, "$1/***")
    .slice(0, max);
}
