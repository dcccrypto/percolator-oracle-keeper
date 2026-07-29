export interface PostgrestPage<T> {
  rows: readonly T[];
  contentRange: string | null;
}

export interface ParsedPostgrestContentRange {
  start: number;
  end: number;
  total: number;
}

export type PostgrestPageFetcher<T> = (
  start: number,
  end: number,
) => Promise<PostgrestPage<T> | null>;

/**
 * Parse an exact PostgREST Content-Range response.
 *
 * Supported responses include:
 * - a non-empty exact range, for example "0-999/1250"
 * - the wildcard empty-range response returned when the exact total is zero
 *
 * Responses with an unknown total are intentionally rejected because an
 * authoritative replacement is unsafe unless snapshot completeness is proven.
 */
export function parsePostgrestContentRange(
  value: string | null,
): ParsedPostgrestContentRange | null {
  if (!value) return null;

  const normalized = value.trim();

  if (normalized === "*/0") {
    return {
      start: 0,
      end: -1,
      total: 0,
    };
  }

  const match = /^(\d+)-(\d+)\/(\d+)$/.exec(
    normalized,
  );

  if (!match) return null;

  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  ) {
    return null;
  }

  return {
    start,
    end,
    total,
  };
}

/**
 * Fetch and validate every page of an authoritative PostgREST snapshot.
 *
 * The snapshot is returned only when:
 * - every page includes an exact Content-Range total
 * - each page begins at the expected offset
 * - response row counts match their declared ranges
 * - the total remains stable across all requests
 * - the collected row count exactly equals the declared total
 *
 * Any transport, parsing, range, or consistency failure returns null so the
 * caller can preserve its previous last known-good snapshot.
 */
export async function collectCompletePostgrestSnapshot<T>(
  fetchPage: PostgrestPageFetcher<T>,
  pageSize = 1_000,
): Promise<T[] | null> {
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0
  ) {
    throw new RangeError(
      "pageSize must be a positive safe integer",
    );
  }

  const collected: T[] = [];
  let nextStart = 0;
  let expectedTotal: number | null = null;

  while (true) {
    let page: PostgrestPage<T> | null;

    try {
      page = await fetchPage(
        nextStart,
        nextStart + pageSize - 1,
      );
    } catch {
      return null;
    }

    if (!page || !Array.isArray(page.rows)) {
      return null;
    }

    const range = parsePostgrestContentRange(
      page.contentRange,
    );

    if (!range) return null;

    if (range.total === 0) {
      if (
        nextStart !== 0 ||
        range.start !== 0 ||
        range.end !== -1 ||
        page.rows.length !== 0
      ) {
        return null;
      }

      return [];
    }

    if (range.start !== nextStart) {
      return null;
    }

    const declaredPageLength =
      range.end - range.start + 1;

    if (page.rows.length !== declaredPageLength) {
      return null;
    }

    if (expectedTotal === null) {
      expectedTotal = range.total;
    } else if (range.total !== expectedTotal) {
      return null;
    }

    if (
      collected.length + page.rows.length >
      range.total
    ) {
      return null;
    }

    collected.push(...page.rows);

    if (range.end === range.total - 1) {
      return collected.length === range.total
        ? collected
        : null;
    }

    nextStart = range.end + 1;
  }
}
