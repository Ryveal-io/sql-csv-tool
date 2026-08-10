import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import type { QueryColumn, QueryResult } from '../types/query';
import type { CsvDialect, CsvLoadOptions } from '../types/dialect';
import { DEFAULT_DIALECT, normalizeSniffed } from '../types/dialect';

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;

export interface LoadedTable {
  fileName: string;
  dialect: CsvDialect;
}

// Track loaded tables: tableName -> { originalFileName, detected dialect }
const loadedTables = new Map<string, LoadedTable>();

function tableNameFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '');
  return stem.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'data';
}

/** Quote a SQL identifier. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a SQL string literal. */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * In VS Code webviews, Vite's `?url` imports produce root-relative paths like
 * `/assets/duckdb-eh.wasm` which resolve to `vscode-webview://host/assets/...`
 * and get 403 Forbidden. The extension injects the correct webview resource base
 * URI as `window.__WEBVIEW_ASSETS_BASE__`. We use it to rewrite asset URLs.
 */
function resolveAssetUrl(url: string): string {
  const base = (window as unknown as Record<string, string>).__WEBVIEW_ASSETS_BASE__;
  if (base && url.startsWith('/assets/')) {
    return `${base}/${url.split('/assets/')[1]}`;
  }
  return url;
}

export async function initDuckDb(): Promise<void> {
  if (db) return;

  console.log('[Chomper] initDuckDb: starting');

  const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
    mvp: { mainModule: duckdb_wasm, mainWorker: mvp_worker },
    eh: { mainModule: duckdb_wasm_eh, mainWorker: eh_worker },
  };

  const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);

  const workerUrl = resolveAssetUrl(bundle.mainWorker!);
  const wasmUrl = resolveAssetUrl(bundle.mainModule);
  console.log('[Chomper] initDuckDb: worker URL:', workerUrl);
  console.log('[Chomper] initDuckDb: WASM URL:', wasmUrl);

  // In VS Code webviews, `new Worker(url)` is intercepted and can fail.
  // Fetch the worker script and create a blob URL to bypass this.
  // Also fetch WASM as bytes since the blob worker can't access webview resource URLs.
  const [workerScript, wasmBuffer] = await Promise.all([
    fetch(workerUrl).then(r => r.text()),
    fetch(wasmUrl).then(r => {
      if (!r.ok) throw new Error(`WASM fetch failed: ${r.status} ${r.statusText} for ${wasmUrl}`);
      return r.arrayBuffer();
    }),
  ]);
  console.log('[Chomper] initDuckDb: worker script fetched, length:', workerScript.length);
  console.log('[Chomper] initDuckDb: WASM fetched, size:', wasmBuffer.byteLength);
  const workerBlob = new Blob([workerScript], { type: 'application/javascript' });
  const wasmBlob = new Blob([wasmBuffer], { type: 'application/wasm' });
  const wasmBlobUrl = URL.createObjectURL(wasmBlob);
  const worker = new Worker(URL.createObjectURL(workerBlob));

  const logger = new duckdb.ConsoleLogger();
  db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(wasmBlobUrl);
  conn = await db.connect();
  console.log('[Chomper] initDuckDb: ready!');
}

/**
 * The only row delimiters DuckDB's `new_line` option accepts, spelled the way
 * it wants them: the literal backslash tokens, not the control characters.
 * `sniff_csv` reports NewLineDelimiter in this same form.
 */
const NEWLINE_TOKENS = ['\\r', '\\n', '\\r\\n'];

/**
 * Render the user's overrides as `sniff_csv()` arguments, so detection of the
 * fields they did *not* specify happens under the constraints they did.
 */
function sniffOverrides(options: CsvLoadOptions): string[] {
  const opts: string[] = [];
  if (options.delimiter !== undefined) opts.push(`delim=${lit(options.delimiter)}`);
  if (options.quote !== undefined) opts.push(`quote=${lit(options.quote)}`);
  if (options.escape !== undefined) opts.push(`escape=${lit(options.escape)}`);
  if (options.hasHeader !== undefined) opts.push(`header=${options.hasHeader}`);
  if (options.skipRows !== undefined) opts.push(`skip=${options.skipRows}`);
  if (options.encoding !== undefined) opts.push(`encoding=${lit(options.encoding)}`);
  if (options.newline !== undefined && NEWLINE_TOKENS.includes(options.newline)) {
    opts.push(`new_line=${lit(options.newline)}`);
  }
  // Detection is as strict as the read, so a user who has already accepted
  // malformed rows needs that tolerance here too or the sniff fails first.
  if (options.ignoreErrors) opts.push('ignore_errors=true');
  return opts;
}

/**
 * Ask DuckDB to detect a registered file's dialect.
 *
 * Any `options` the caller has already decided on are pinned for the sniff.
 * That matters on reload: the fields the user left alone must be re-detected
 * against the dialect they just corrected, not carried over from the one they
 * rejected. A file mis-sniffed as single-column pipe-delimited reports no quote
 * character, and reusing that alongside a corrected comma delimiter makes the
 * load fail outright.
 *
 * Returns null if sniffing is unavailable or fails, in which case callers fall
 * back to `read_csv_auto` and the default dialect — a worse round-trip, but
 * still a successful open.
 */
export async function sniffCsv(
  fileName: string,
  options: CsvLoadOptions = {}
): Promise<CsvDialect | null> {
  if (!conn) throw new Error('DuckDB not connected');
  try {
    const args = [lit(fileName), ...sniffOverrides(options)].join(', ');
    const result = await conn.query(`SELECT * FROM sniff_csv(${args})`);
    if (result.numRows === 0) return null;

    const read = (col: string) => result.getChild(col)?.get(0);
    const skipRows = Number(read('SkipRows') ?? 0);
    const dateFormat = normalizeSniffed(read('DateFormat'));
    const timestampFormat = normalizeSniffed(read('TimestampFormat'));

    return {
      delimiter: normalizeSniffed(read('Delimiter')) || ',',
      quote: normalizeSniffed(read('Quote')),
      escape: normalizeSniffed(read('Escape')),
      newline: normalizeSniffed(read('NewLineDelimiter')) || '\n',
      hasHeader: Boolean(read('HasHeader')),
      skipRows: Number.isFinite(skipRows) ? skipRows : 0,
      dateFormat: dateFormat || undefined,
      timestampFormat: timestampFormat || undefined,
    };
  } catch (err) {
    console.warn('[Chomper] sniff_csv failed, falling back to auto-detect:', err);
    return null;
  }
}

/** Build the option list for a `read_csv()` call from a resolved dialect. */
function readOptions(dialect: CsvDialect, options: CsvLoadOptions): string[] {
  const opts = [
    `delim=${lit(dialect.delimiter)}`,
    `quote=${lit(dialect.quote)}`,
    `escape=${lit(dialect.escape)}`,
    `header=${dialect.hasHeader}`,
    `skip=${dialect.skipRows}`,
  ];
  // Only pinned on explicit request. The sniffed value already agrees with the
  // file, so pinning it would buy nothing while making loads stricter than
  // auto-detection — a file with mixed line endings that DuckDB currently
  // copes with would start failing.
  if (options.newline !== undefined && NEWLINE_TOKENS.includes(options.newline)) {
    opts.push(`new_line=${lit(options.newline)}`);
  }
  if (dialect.dateFormat) opts.push(`dateformat=${lit(dialect.dateFormat)}`);
  if (dialect.timestampFormat) opts.push(`timestampformat=${lit(dialect.timestampFormat)}`);
  if (dialect.encoding) opts.push(`encoding=${lit(dialect.encoding)}`);
  if (options.allVarchar) opts.push('all_varchar=true');
  if (options.ignoreErrors) opts.push('ignore_errors=true');
  return opts;
}

/**
 * Load a CSV/TSV/delimited file into a table.
 *
 * The file's dialect is sniffed and then overlaid with any explicit `options`,
 * so callers only override what detection got wrong. The resolved dialect is
 * retained so the file can later be written back in its original format.
 */
export async function loadCsvFromBytes(
  fileName: string,
  content: Uint8Array,
  options: CsvLoadOptions = {}
): Promise<string> {
  if (!db || !conn) throw new Error('DuckDB not initialized');

  const tableName = tableNameFromFileName(fileName);
  // Re-registering a name that is already taken can fail, and reloading the
  // same file with different options is a normal thing to do. The table is
  // materialized by CREATE TABLE AS, so nothing points at the old buffer.
  await db.dropFile(fileName).catch(() => undefined);
  await db.registerFileBuffer(fileName, content);

  const sniffed = await sniffCsv(fileName, options);
  const dialect: CsvDialect = {
    ...DEFAULT_DIALECT,
    ...(sniffed ?? {}),
    ...(options.delimiter !== undefined && { delimiter: options.delimiter }),
    ...(options.quote !== undefined && { quote: options.quote }),
    ...(options.escape !== undefined && { escape: options.escape }),
    ...(options.newline !== undefined && { newline: options.newline }),
    ...(options.hasHeader !== undefined && { hasHeader: options.hasHeader }),
    ...(options.skipRows !== undefined && { skipRows: options.skipRows }),
    ...(options.encoding !== undefined && { encoding: options.encoding }),
    ...(options.dateFormat !== undefined && { dateFormat: options.dateFormat }),
  };

  // With nothing sniffed and nothing overridden we have no better information
  // than DuckDB's own auto-detection, so let it do the work.
  const useAuto = !sniffed && Object.keys(options).length === 0;
  const source = useAuto
    ? `read_csv_auto(${lit(fileName)})`
    : `read_csv(${lit(fileName)}, ${readOptions(dialect, options).join(', ')})`;

  await conn.query(`
    CREATE OR REPLACE TABLE ${ident(tableName)} AS
    SELECT * FROM ${source}
  `);

  loadedTables.set(tableName, { fileName, dialect });
  return tableName;
}

/** The dialect a table was loaded with, if known. */
export function getTableDialect(tableName: string): CsvDialect | undefined {
  return loadedTables.get(tableName)?.dialect;
}

/**
 * Re-parse an already-loaded file with different options, for when detection
 * guessed the delimiter or header wrong.
 *
 * Reuses the buffer registered at load time rather than asking the caller to
 * hold the file bytes a second time. Any edits made to the table are discarded,
 * since this reparses the file from source.
 */
export async function reloadTableWithOptions(
  tableName: string,
  options: CsvLoadOptions
): Promise<string> {
  if (!db || !conn) throw new Error('DuckDB not initialized');
  const entry = loadedTables.get(tableName);
  if (!entry) throw new Error(`Table "${tableName}" was not loaded from a file`);

  const bytes = await db.copyFileToBuffer(entry.fileName);
  return loadCsvFromBytes(entry.fileName, bytes, options);
}

export async function describeTable(tableName: string): Promise<QueryColumn[]> {
  if (!conn) throw new Error('DuckDB not connected');
  const result = await conn.query(
    `SELECT column_name, column_type FROM (DESCRIBE "${tableName}")`
  );
  const columns: QueryColumn[] = [];
  for (let i = 0; i < result.numRows; i++) {
    columns.push({
      name: String(result.getChild('column_name')?.get(i)),
      type: String(result.getChild('column_type')?.get(i)),
    });
  }
  return columns;
}

export function getLoadedTables(): Map<string, LoadedTable> {
  return new Map(loadedTables);
}

export interface WriteOptions {
  delimiter: string;
  quoteStyle: 'always' | 'as-needed' | 'never';
  includeHeader: boolean;
  includeRowNumbers?: boolean;
  dateFormat?: string;
}

/**
 * Write options that reproduce the file's original format. Used for plain Save,
 * where the intent is to edit a file in place rather than convert it.
 */
export function writeOptionsForTable(tableName: string): WriteOptions {
  const dialect = getTableDialect(tableName) ?? DEFAULT_DIALECT;
  return {
    delimiter: dialect.delimiter,
    quoteStyle: 'as-needed',
    includeHeader: dialect.hasHeader,
    dateFormat: dialect.dateFormat,
  };
}

/** Render a COPY ... (FORMAT CSV, ...) option list. */
function copyOptions(options: WriteOptions): string {
  const opts = ['FORMAT CSV', `DELIMITER ${lit(options.delimiter)}`];
  if (options.includeHeader) opts.push('HEADER');
  if (options.quoteStyle === 'always') {
    opts.push('FORCE_QUOTE *');
  } else if (options.quoteStyle === 'never') {
    // Emits values raw. A value containing the delimiter then reads back as two
    // fields, so this can produce a file that no longer parses — offered only
    // because some downstream fixed-format readers reject quotes outright.
    opts.push("QUOTE ''");
  }
  if (options.dateFormat) opts.push(`DATEFORMAT ${lit(options.dateFormat)}`);
  return opts.join(', ');
}

/** Run a COPY to an in-memory file and hand back the resulting bytes. */
async function copyToBytes(
  sourceExpr: string,
  options: WriteOptions,
  scratchFile: string
): Promise<Uint8Array> {
  if (!conn || !db) throw new Error('DuckDB not connected');
  await conn.query(`COPY ${sourceExpr} TO ${lit(scratchFile)} (${copyOptions(options)})`);
  try {
    return await db.copyFileToBuffer(scratchFile);
  } finally {
    // Without this the next COPY to the same name fails or serves stale bytes.
    await db.dropFile(scratchFile).catch(() => undefined);
  }
}

export async function executeQuery(sql: string): Promise<QueryResult> {
  if (!conn) throw new Error('DuckDB not connected');

  const start = performance.now();
  const result = await conn.query(sql);
  const queryTimeMs = performance.now() - start;

  const columns = result.schema.fields.map((f) => ({
    name: f.name,
    type: f.type.toString(),
  }));

  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < result.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const col of columns) {
      row[col.name] = result.getChild(col.name)?.get(i);
    }
    rows.push(row);
  }

  return { columns, rows, rowCount: result.numRows, queryTimeMs };
}

export async function exportCsv(tableName?: string): Promise<Uint8Array> {
  if (!conn || !db) throw new Error('DuckDB not connected');
  const table = tableName || (loadedTables.keys().next().value ?? 'data');
  return copyToBytes(ident(table), writeOptionsForTable(table), 'export.csv');
}

export async function dropTable(tableName: string): Promise<void> {
  if (!conn) throw new Error('DuckDB not connected');
  await conn.query(`DROP TABLE IF EXISTS ${ident(tableName)}`);
  loadedTables.delete(tableName);
}

export async function updateCell(
  tableName: string,
  rowid: number,
  columnName: string,
  value: string | null,
  columnType: string
): Promise<void> {
  if (!conn) throw new Error('DuckDB not connected');
  const escaped = columnName.replace(/"/g, '""');
  let valExpr: string;
  if (value === null || value === '') {
    valExpr = 'NULL';
  } else if (/INT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|BIGINT|SMALLINT|TINYINT|HUGEINT/i.test(columnType)) {
    valExpr = value;
  } else {
    valExpr = `'${value.replace(/'/g, "''")}'`;
  }
  await conn.query(`UPDATE "${tableName}" SET "${escaped}" = ${valExpr} WHERE rowid = ${rowid}`);
}

/**
 * Serialize a table for an in-place Save, reproducing the dialect it was loaded
 * with. Saving must not silently convert a pipe-delimited or tab-delimited file
 * to comma-delimited under its original name.
 */
export async function saveTableToBytes(tableName: string): Promise<Uint8Array> {
  return copyToBytes(ident(tableName), writeOptionsForTable(tableName), 'save_export.csv');
}

export interface ColumnProfile {
  totalRows: number;
  nullCount: number;
  distinctCount: number;
  topValues: { value: string; count: number }[];
  numericStats?: { min: number; max: number; avg: number; median: number };
}

export interface DateProfile {
  minDate: string;
  maxDate: string;
  buckets: { period: string; count: number }[];
}

function isNumericColumnType(type: string): boolean {
  return /INT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|BIGINT|SMALLINT|TINYINT|HUGEINT/i.test(type);
}

function isDateColumnType(type: string): boolean {
  return /DATE|TIMESTAMP|TIMESTAMPTZ|DATETIME/i.test(type);
}

export { isDateColumnType };

export interface ColumnQuickStats {
  distinctCount: number;
  nullCount: number;
  totalRows: number;
  /** Rows holding '' rather than NULL. See the note on emptyCount below. */
  emptyCount: number;
  /** Rows that are non-empty but contain only whitespace, e.g. a single space. */
  whitespaceCount: number;
  /** Longest and shortest rendered value. The usual question for fixed-format
   *  files, where an overlong field means an upstream overflow. */
  maxLength: number | null;
  minLength: number | null;
  /** Non-null values that would survive TRY_CAST to BIGINT. Surfaces numeric
   *  data sitting in a text field, e.g. an NPI in a name column. */
  numericCastableCount: number | null;
}

export async function getColumnQuickStats(
  tableName: string,
  columns: { name: string; type: string }[]
): Promise<Map<string, ColumnQuickStats>> {
  if (!conn) throw new Error('DuckDB not connected');
  if (columns.length === 0) return new Map();
  const tbl = ident(tableName);

  // Aliases are positional rather than derived from the column name: slugging
  // the name collides for columns that differ only in punctuation ("a b" and
  // "a-b" both slug to "a_b"), which silently mixes up their stats.
  const selects = columns.flatMap((c, i) => {
    const col = ident(c.name);
    const text = `${col}::VARCHAR`;
    const parts = [
      `COUNT(DISTINCT ${col}) as c${i}_dist`,
      `COUNT(*) - COUNT(${col}) as c${i}_null`,
      `COUNT(*) FILTER (WHERE ${text} = '') as c${i}_empty`,
      `COUNT(*) FILTER (WHERE ${text} <> '' AND TRIM(${text}) = '') as c${i}_ws`,
      `MAX(LENGTH(${text})) as c${i}_maxlen`,
      `MIN(LENGTH(${text})) as c${i}_minlen`,
    ];
    // Only meaningful for text columns; a numeric column is castable by definition.
    parts.push(
      isNumericColumnType(c.type)
        ? `NULL as c${i}_num`
        : `COUNT(TRY_CAST(${text} AS BIGINT)) as c${i}_num`
    );
    return parts;
  });

  const result = await conn.query(
    `SELECT COUNT(*) as total, ${selects.join(', ')} FROM ${tbl}`
  );
  const total = Number(result.getChild('total')?.get(0) ?? 0);

  const num = (alias: string): number | null => {
    const v = result.getChild(alias)?.get(0);
    return v === null || v === undefined ? null : Number(v);
  };

  const stats = new Map<string, ColumnQuickStats>();
  columns.forEach((c, i) => {
    stats.set(c.name, {
      distinctCount: num(`c${i}_dist`) ?? 0,
      nullCount: num(`c${i}_null`) ?? 0,
      totalRows: total,
      emptyCount: num(`c${i}_empty`) ?? 0,
      whitespaceCount: num(`c${i}_ws`) ?? 0,
      maxLength: num(`c${i}_maxlen`),
      minLength: num(`c${i}_minlen`),
      numericCastableCount: num(`c${i}_num`),
    });
  });
  return stats;
}

export async function profileColumn(
  tableName: string,
  columnName: string,
  columnType: string
): Promise<ColumnProfile> {
  if (!conn) throw new Error('DuckDB not connected');
  const col = `"${columnName.replace(/"/g, '""')}"`;
  const tbl = `"${tableName.replace(/"/g, '""')}"`;

  // Stats query
  const statsResult = await conn.query(
    `SELECT COUNT(*) as total, COUNT(*) - COUNT(${col}) as nulls, COUNT(DISTINCT ${col}) as dist FROM ${tbl}`
  );
  const totalRows = Number(statsResult.getChild('total')?.get(0) ?? 0);
  const nullCount = Number(statsResult.getChild('nulls')?.get(0) ?? 0);
  const distinctCount = Number(statsResult.getChild('dist')?.get(0) ?? 0);

  // Top values
  const topResult = await conn.query(
    `SELECT CAST(${col} AS VARCHAR) as value, COUNT(*) as cnt FROM ${tbl} GROUP BY ${col} ORDER BY cnt DESC LIMIT 500`
  );
  const topValues: { value: string; count: number }[] = [];
  for (let i = 0; i < topResult.numRows; i++) {
    const v = topResult.getChild('value')?.get(i);
    topValues.push({
      value: v === null || v === undefined ? 'NULL' : String(v),
      count: Number(topResult.getChild('cnt')?.get(i) ?? 0),
    });
  }

  // Numeric stats
  let numericStats: ColumnProfile['numericStats'];
  if (isNumericColumnType(columnType)) {
    try {
      const numResult = await conn.query(
        `SELECT MIN(${col}) as mn, MAX(${col}) as mx, ROUND(AVG(${col}),2) as av, ROUND(MEDIAN(${col}),2) as md FROM ${tbl}`
      );
      numericStats = {
        min: Number(numResult.getChild('mn')?.get(0)),
        max: Number(numResult.getChild('mx')?.get(0)),
        avg: Number(numResult.getChild('av')?.get(0)),
        median: Number(numResult.getChild('md')?.get(0)),
      };
    } catch {
      // MEDIAN may not be available, skip
    }
  }

  return { totalRows, nullCount, distinctCount, topValues, numericStats };
}

export async function profileDateColumn(
  tableName: string,
  columnName: string,
  granularity: 'hour' | 'day' | 'week' | 'month' | 'year'
): Promise<DateProfile> {
  if (!conn) throw new Error('DuckDB not connected');
  const col = `"${columnName.replace(/"/g, '""')}"`;
  const tbl = `"${tableName.replace(/"/g, '""')}"`;

  const rangeResult = await conn.query(
    `SELECT MIN(${col})::VARCHAR as min_date, MAX(${col})::VARCHAR as max_date FROM ${tbl}`
  );
  const minDate = String(rangeResult.getChild('min_date')?.get(0) ?? '');
  const maxDate = String(rangeResult.getChild('max_date')?.get(0) ?? '');

  const bucketsResult = await conn.query(
    `SELECT DATE_TRUNC('${granularity}', ${col})::VARCHAR as period, COUNT(*) as cnt FROM ${tbl} WHERE ${col} IS NOT NULL GROUP BY 1 ORDER BY 1`
  );
  const buckets: { period: string; count: number }[] = [];
  for (let i = 0; i < bucketsResult.numRows; i++) {
    buckets.push({
      period: String(bucketsResult.getChild('period')?.get(i) ?? ''),
      count: Number(bucketsResult.getChild('cnt')?.get(i) ?? 0),
    });
  }

  return { minDate, maxDate, buckets };
}

export async function getTableRowCount(tableName: string): Promise<number> {
  if (!conn) throw new Error('DuckDB not connected');
  const result = await conn.query(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
  return Number(result.getChild('cnt')?.get(0) ?? 0);
}

export async function renameColumn(tableName: string, oldName: string, newName: string): Promise<void> {
  if (!conn) throw new Error('DuckDB not connected');
  const tbl = tableName.replace(/"/g, '""');
  const old = oldName.replace(/"/g, '""');
  const nw = newName.replace(/"/g, '""');
  await conn.query(`ALTER TABLE "${tbl}" RENAME COLUMN "${old}" TO "${nw}"`);
}

export async function addColumn(tableName: string, columnName: string, columnType: string = 'VARCHAR'): Promise<void> {
  if (!conn) throw new Error('DuckDB not connected');
  const tbl = tableName.replace(/"/g, '""');
  const col = columnName.replace(/"/g, '""');
  await conn.query(`ALTER TABLE "${tbl}" ADD COLUMN "${col}" ${columnType}`);
}

export async function dropColumn(tableName: string, columnName: string): Promise<void> {
  if (!conn) throw new Error('DuckDB not connected');
  const tbl = tableName.replace(/"/g, '""');
  const col = columnName.replace(/"/g, '""');
  await conn.query(`ALTER TABLE "${tbl}" DROP COLUMN "${col}"`);
}

export async function reorderColumns(tableName: string, columnOrder: string[]): Promise<void> {
  if (!conn) throw new Error('DuckDB not connected');
  const tbl = tableName.replace(/"/g, '""');
  const selectCols = columnOrder.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');
  await conn.query(`CREATE TABLE "__reorder_tmp" AS SELECT ${selectCols} FROM "${tbl}"`);
  await conn.query(`DROP TABLE "${tbl}"`);
  await conn.query(`ALTER TABLE "__reorder_tmp" RENAME TO "${tbl}"`);
}

export async function findReplaceInColumn(
  tableName: string,
  columnName: string,
  find: string,
  replace: string,
  options: { caseSensitive: boolean; regex: boolean }
): Promise<number> {
  if (!conn) throw new Error('DuckDB not connected');
  const tbl = `"${tableName.replace(/"/g, '""')}"`;
  const col = `"${columnName.replace(/"/g, '""')}"`;
  const findEscaped = find.replace(/'/g, "''");
  const replaceEscaped = replace.replace(/'/g, "''");

  let sql: string;
  if (options.regex) {
    sql = `UPDATE ${tbl} SET ${col} = REGEXP_REPLACE(${col}::VARCHAR, '${findEscaped}', '${replaceEscaped}', 'g') WHERE REGEXP_MATCHES(${col}::VARCHAR, '${findEscaped}')`;
  } else if (options.caseSensitive) {
    sql = `UPDATE ${tbl} SET ${col} = REPLACE(${col}::VARCHAR, '${findEscaped}', '${replaceEscaped}') WHERE ${col}::VARCHAR LIKE '%${findEscaped}%'`;
  } else {
    sql = `UPDATE ${tbl} SET ${col} = REPLACE(LOWER(${col}::VARCHAR), '${findEscaped.toLowerCase()}', '${replaceEscaped}') WHERE ${col}::VARCHAR ILIKE '%${findEscaped}%'`;
  }

  const result = await conn.query(sql);
  return result.numRows;
}

export async function countMatches(
  tableName: string,
  columnName: string | null,
  find: string,
  options: { caseSensitive: boolean; regex: boolean }
): Promise<number> {
  if (!conn) throw new Error('DuckDB not connected');
  const tbl = `"${tableName.replace(/"/g, '""')}"`;
  const findEscaped = find.replace(/'/g, "''");

  let whereClause: string;
  if (columnName) {
    const col = `"${columnName.replace(/"/g, '""')}"`;
    if (options.regex) {
      whereClause = `REGEXP_MATCHES(${col}::VARCHAR, '${findEscaped}')`;
    } else if (options.caseSensitive) {
      whereClause = `${col}::VARCHAR LIKE '%${findEscaped}%'`;
    } else {
      whereClause = `${col}::VARCHAR ILIKE '%${findEscaped}%'`;
    }
  } else {
    // Search all columns — get column list
    const cols = await describeTable(tableName);
    const conditions = cols.map(c => {
      const col = `"${c.name.replace(/"/g, '""')}"`;
      if (options.regex) return `REGEXP_MATCHES(${col}::VARCHAR, '${findEscaped}')`;
      if (options.caseSensitive) return `${col}::VARCHAR LIKE '%${findEscaped}%'`;
      return `${col}::VARCHAR ILIKE '%${findEscaped}%'`;
    });
    whereClause = conditions.join(' OR ');
  }

  const result = await conn.query(`SELECT COUNT(*) as cnt FROM ${tbl} WHERE ${whereClause}`);
  return Number(result.getChild('cnt')?.get(0) ?? 0);
}

export async function executeCountQuery(sql: string): Promise<number> {
  if (!conn) throw new Error('DuckDB not connected');
  const result = await conn.query(sql);
  return Number(result.getChild('cnt')?.get(0) ?? 0);
}

export async function saveTableWithOptions(
  tableName: string,
  options: {
    delimiter: string;
    quoteStyle: 'always' | 'as-needed' | 'never';
    includeHeader: boolean;
    includeRowNumbers: boolean;
  }
): Promise<Uint8Array> {
  const tbl = ident(tableName);
  const sourceExpr = options.includeRowNumbers
    ? `(SELECT ROW_NUMBER() OVER () as row_num, * FROM ${tbl})`
    : tbl;

  return copyToBytes(
    sourceExpr,
    {
      delimiter: options.delimiter,
      quoteStyle: options.quoteStyle,
      includeHeader: options.includeHeader,
      dateFormat: getTableDialect(tableName)?.dateFormat,
    },
    'save_as_export.csv'
  );
}

export function getConnection(): duckdb.AsyncDuckDBConnection | null {
  return conn;
}
