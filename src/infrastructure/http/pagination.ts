// Shared query-string pagination parsing + response-shape helper for every
// paginated list endpoint (see the "Add pagination to every list page in
// RUTA" plan). One implementation for the "page/pageSize in, { page,
// pageSize, total, totalPages } out" convention every list endpoint below
// now follows, so the page-size clamping rule (only 25/50/100 allowed) and
// the response shape stay identical everywhere instead of being hand-rolled
// per handler.

const ALLOWED_PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

export interface PaginationParams {
  page: number;
  pageSize: number;
  offset: number;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Reads `page`/`pageSize` off a Vercel request's `req.query` (or any
 * plain string-keyed record). `page` clamps to >= 1 (a stale/invalid page
 * number - e.g. left over after a search narrows the result set - falls
 * back to 1 rather than erroring). `pageSize` clamps to the nearest
 * allowed value in ALLOWED_PAGE_SIZES rather than accepting an arbitrary
 * number; an unbounded pageSize would defeat the entire point of adding
 * pagination in the first place. */
export function parsePagination(query: Record<string, unknown>): PaginationParams {
  const rawPage = Number(query.page);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const rawPageSize = Number(query.pageSize);
  const pageSize = (ALLOWED_PAGE_SIZES as readonly number[]).includes(rawPageSize) ? rawPageSize : DEFAULT_PAGE_SIZE;

  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Builds the `pagination` object every paginated endpoint's response adds
 * alongside its existing named array key (e.g. `{ campaigns, pagination }`)
 * - purely additive, so no existing consumer of that array key breaks. */
export function buildPaginationMeta(page: number, pageSize: number, total: number): PaginationMeta {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
