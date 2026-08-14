// `getDb()` returns a union type (node-postgres driver locally, Neon HTTP
// driver in production - see client.ts), so TypeScript can't statically
// know a `.returning()` array has at least one element even when the query
// guarantees it (a single-row insert/update by primary key). This helper
// makes that assumption explicit at the one place it's made, instead of a
// non-null assertion (`row!`) scattered through every repository function.
export function firstOrThrow<T>(rows: T[], message = "Expected the query to return at least one row"): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(message);
  }
  return row;
}
