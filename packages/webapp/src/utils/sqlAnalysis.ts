const CHUNK_SIZE = 10_000;

/**
 * Detect whether the user's SQL already has a LIMIT clause at the outermost level.
 */
export function hasExplicitLimit(sql: string): boolean {
  // Remove string literals and comments
  const cleaned = sql
    .replace(/'[^']*'/g, "''")
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // Collapse balanced parentheses (handles subqueries)
  let prev = '';
  let s = cleaned;
  while (s !== prev) {
    prev = s;
    s = s.replace(/\([^()]*\)/g, '()');
  }

  return /\bLIMIT\s+\d+/i.test(s);
}

/**
 * Build a chunked query by appending LIMIT and OFFSET.
 */
export function buildChunkedQuery(sql: string, offset: number, limit: number = CHUNK_SIZE): string {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (offset > 0) {
    return `${trimmed} LIMIT ${limit} OFFSET ${offset}`;
  }
  return `${trimmed} LIMIT ${limit}`;
}

/**
 * Build a COUNT(*) wrapper around the user's query.
 */
export function buildCountQuery(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  return `SELECT COUNT(*) as cnt FROM (${trimmed}) AS __count_subquery`;
}

export { CHUNK_SIZE };
