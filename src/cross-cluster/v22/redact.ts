/**
 * cross-cluster/v22/redact.ts
 *
 * Error text from the RPC / fetch stack can embed the request URL, including `?api-key=<secret>`. v2.2 error text
 * reaches logs AND `/health` (`jobs.*.lastError`, `layoutProblems`), and /health binds 0.0.0.0, so every v2.2 string
 * goes through this redactor first.
 */
export function redactErrorText(s: string, max = 160): string {
  return s
    .replace(/(api[-_]?key|apikey|token|secret|auth)=[^&\s"')]+/gi, "$1=***")
    .replace(/https?:\/\/[^\s"')]+/gi, (u) => {
      try {
        const url = new URL(u);
        return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search ? "?***" : ""}`;
      } catch {
        return "<url>";
      }
    })
    .slice(0, max);
}
