import { Database } from 'duckdb-async';
import path from 'path';
import fs from 'fs';
import os from 'os';

interface QueryColumn {
  name: string;
  type: string;
}

interface QueryResult {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

interface TableInfo {
  name: string;
  columns: QueryColumn[];
  rowCount: number;
}

/** Dialect of a delimited file, as detected by sniff_csv and/or overridden by the caller. */
export interface CsvDialect {
  delimiter: string;
  quote: string;
  escape: string;
  /** Descriptive only (e.g. "\\n"). Not fed back into read_csv — DuckDB auto-detects. */
  newline: string;
  hasHeader: boolean;
  skipRows: number;
  dateFormat?: string;
  timestampFormat?: string;
  /** DuckDB supports utf-8, utf-16, latin-1. */
  encoding?: string;
}

export interface TableMeta {
  table: string;
  sourcePath: string;
  dialect: CsvDialect;
  loadedAt: string;
}

export interface LoadCsvOptions {
  tableName?: string;
  delimiter?: string;
  header?: boolean;
  quote?: string;
  escape?: string;
  /** Row delimiter. DuckDB accepts only the tokens '\r', '\n' and '\r\n'. */
  newline?: string;
  skipRows?: number;
  encoding?: string;
  allVarchar?: boolean;
  nullstr?: string;
  dateFormat?: string;
  sampleSize?: number;
  ignoreErrors?: boolean;
}

/**
 * The only row delimiters DuckDB's `new_line` option accepts, spelled the way
 * it wants them: the literal two- and four-character backslash tokens, not the
 * control characters themselves. `sniff_csv` reports NewLineDelimiter in
 * exactly this form, so a sniffed value can be fed straight back in.
 */
const NEWLINE_TOKENS = new Set(['\\r', '\\n', '\\r\\n']);

export interface SaveTableOptions {
  delimiter?: string;
  header?: boolean;
  quoteStyle?: 'always' | 'as-needed';
  dateFormat?: string;
}

let db: Database | null = null;

/** Metadata for every table loaded in this process. Data never lives here. */
const tableMeta = new Map<string, TableMeta>();

// --- Escaping helpers ---

/** Quote a SQL identifier (table/column name). */
const q = (s: string): string => '"' + s.replace(/"/g, '""') + '"';

/** Escape a SQL string literal body (caller supplies the surrounding quotes). */
const lit = (s: string): string => s.replace(/'/g, "''");

/** sniff_csv reports absent quote/escape chars as the literal text "(empty)". */
function normalizeSniffed(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return s === '(empty)' ? '' : s;
}

function tableNameFromPath(filePath: string): string {
  const base = path.basename(filePath);
  // Remove extension and sanitize
  const stem = base.replace(/\.[^.]+$/, '');
  return stem.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'data';
}

const NUMERIC_TYPES = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)/i;
const isNumericType = (t: string): boolean => NUMERIC_TYPES.test(t.trim());
const isVarcharType = (t: string): boolean => /^VARCHAR|^TEXT|^STRING/i.test(t.trim());

export async function init(): Promise<void> {
  if (!db) {
    db = await Database.create(':memory:');
    loadSessions();
  }
}

function getDb(): Database {
  if (!db) throw new Error('DuckDB not initialized. Call init() first.');
  return db;
}

// --- Session persistence (metadata only — never row data) ---

const SESSION_DIR = path.join(os.homedir(), '.sql-csv-chomper');
const SESSION_FILE = path.join(SESSION_DIR, 'sessions.json');

type SessionStore = Record<string, Record<string, TableMeta>>;

/** Remembered metadata for the current cwd, populated on init. */
let remembered: Record<string, TableMeta> = {};

function readSessionStore(): SessionStore {
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as SessionStore;
  } catch {
    // Missing, unreadable, or corrupt — treat as empty. Never throw.
    return {};
  }
}

function loadSessions(): void {
  const store = readSessionStore();
  const entry = store[process.cwd()];
  remembered = entry && typeof entry === 'object' ? entry : {};
}

function writeSessions(): void {
  try {
    const store = readSessionStore();
    const current: Record<string, TableMeta> = {};
    for (const [name, meta] of tableMeta) current[name] = meta;
    store[process.cwd()] = current;
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(store, null, 2), 'utf8');
    remembered = current;
  } catch {
    // Persistence is best-effort — a failure here must never break a load/drop.
  }
}

/** Tables remembered from a previous session in this cwd. */
export function listRememberedTables(): TableMeta[] {
  return Object.values(remembered);
}

export interface ReloadResult {
  table: string;
  sourcePath: string;
  status: 'reloaded' | 'missing' | 'error';
  message?: string;
  rowCount?: number;
}

/** Re-run loadCsv for each remembered table using its stored dialect. Never throws. */
export async function reloadRememberedTables(): Promise<ReloadResult[]> {
  const results: ReloadResult[] = [];
  for (const meta of Object.values(remembered)) {
    if (!fs.existsSync(meta.sourcePath)) {
      results.push({ table: meta.table, sourcePath: meta.sourcePath, status: 'missing', message: 'source file no longer exists' });
      continue;
    }
    try {
      await loadCsv(meta.sourcePath, {
        tableName: meta.table,
        delimiter: meta.dialect.delimiter,
        quote: meta.dialect.quote,
        escape: meta.dialect.escape,
        header: meta.dialect.hasHeader,
        skipRows: meta.dialect.skipRows,
        encoding: meta.dialect.encoding,
        dateFormat: meta.dialect.dateFormat,
      });
      const { rowCount } = await getTableColumns(meta.table);
      results.push({ table: meta.table, sourcePath: meta.sourcePath, status: 'reloaded', rowCount });
    } catch (err: unknown) {
      results.push({
        table: meta.table,
        sourcePath: meta.sourcePath,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

// --- Dialect detection ---

/**
 * Render the caller's overrides as `sniff_csv()` arguments, so the fields they
 * did *not* specify are detected under the constraints they did.
 *
 * Detection produces a dialect as a set. When the caller corrects one field,
 * the rest of that set stops being evidence: a file mis-sniffed as
 * single-column pipe-delimited reports no quote character, and reusing that
 * alongside a corrected comma delimiter makes the load fail outright.
 */
function sniffOverrides(opts: LoadCsvOptions): string[] {
  const args: string[] = [];
  if (opts.delimiter !== undefined) args.push(`delim='${lit(opts.delimiter)}'`);
  if (opts.quote !== undefined) args.push(`quote='${lit(opts.quote)}'`);
  if (opts.escape !== undefined) args.push(`escape='${lit(opts.escape)}'`);
  if (opts.header !== undefined) args.push(`header=${opts.header ? 'true' : 'false'}`);
  if (opts.skipRows !== undefined) args.push(`skip=${Math.trunc(opts.skipRows)}`);
  if (opts.encoding !== undefined) args.push(`encoding='${lit(opts.encoding)}'`);
  if (opts.newline !== undefined && NEWLINE_TOKENS.has(opts.newline)) {
    args.push(`new_line='${lit(opts.newline)}'`);
  }
  // Detection is as strict as the read, so a caller who has already accepted
  // malformed rows needs that tolerance here too or the sniff fails first.
  if (opts.ignoreErrors) args.push('ignore_errors=true');
  return args;
}

export async function sniffCsv(filePath: string, opts: LoadCsvOptions = {}): Promise<CsvDialect> {
  const d = getDb();
  const absPath = path.resolve(filePath);
  const args = [`'${lit(absPath)}'`, ...sniffOverrides(opts)].join(', ');
  const rows = await d.all(`SELECT * FROM sniff_csv(${args})`);
  const r = rows[0] as any;
  if (!r) throw new Error(`Could not sniff CSV dialect for "${filePath}"`);

  return {
    delimiter: normalizeSniffed(r.Delimiter),
    quote: normalizeSniffed(r.Quote),
    escape: normalizeSniffed(r.Escape),
    newline: normalizeSniffed(r.NewLineDelimiter),
    hasHeader: Boolean(r.HasHeader),
    skipRows: Number(r.SkipRows ?? 0),
    dateFormat: r.DateFormat ? String(r.DateFormat) : undefined,
    timestampFormat: r.TimestampFormat ? String(r.TimestampFormat) : undefined,
  };
}

export function getTableMeta(table: string): TableMeta | undefined {
  return tableMeta.get(table);
}

export function listTableMeta(): TableMeta[] {
  return Array.from(tableMeta.values());
}

// --- Loading ---

export async function loadCsv(filePath: string, opts: LoadCsvOptions = {}): Promise<string> {
  const d = getDb();
  const name = opts.tableName || tableNameFromPath(filePath);
  const absPath = path.resolve(filePath);

  // Sniff under the caller's overrides, then let those overrides win.
  const sniffed = await sniffCsv(absPath, opts);
  const dialect: CsvDialect = {
    delimiter: opts.delimiter ?? sniffed.delimiter,
    quote: opts.quote ?? sniffed.quote,
    escape: opts.escape ?? sniffed.escape,
    newline: opts.newline ?? sniffed.newline,
    hasHeader: opts.header ?? sniffed.hasHeader,
    skipRows: opts.skipRows ?? sniffed.skipRows,
    dateFormat: opts.dateFormat ?? sniffed.dateFormat,
    timestampFormat: sniffed.timestampFormat,
    encoding: opts.encoding,
  };

  // Build an explicit read_csv call rather than read_csv_auto so the dialect is pinned.
  const args: string[] = [`'${lit(absPath)}'`];
  args.push(`delim='${lit(dialect.delimiter)}'`);
  args.push(`quote='${lit(dialect.quote)}'`);
  args.push(`escape='${lit(dialect.escape)}'`);
  args.push(`header=${dialect.hasHeader ? 'true' : 'false'}`);
  // Only pinned when the caller asks for it. Sniffing already agrees with the
  // file, so pinning the sniffed value would buy nothing while making loads
  // stricter than auto-detection — a file with mixed line endings that DuckDB
  // currently copes with would start failing.
  if (opts.newline !== undefined && NEWLINE_TOKENS.has(opts.newline)) {
    args.push(`new_line='${lit(opts.newline)}'`);
  }
  if (dialect.skipRows > 0) args.push(`skip=${Math.trunc(dialect.skipRows)}`);
  if (dialect.dateFormat) args.push(`dateformat='${lit(dialect.dateFormat)}'`);
  if (dialect.encoding) args.push(`encoding='${lit(dialect.encoding)}'`);
  if (opts.allVarchar) args.push('all_varchar=true');
  if (opts.nullstr !== undefined) args.push(`nullstr='${lit(opts.nullstr)}'`);
  if (opts.sampleSize !== undefined) args.push(`sample_size=${Math.trunc(opts.sampleSize)}`);
  if (opts.ignoreErrors) args.push('ignore_errors=true');

  await d.exec(`
    CREATE OR REPLACE TABLE ${q(name)} AS
    SELECT * FROM read_csv(${args.join(', ')})
  `);

  tableMeta.set(name, {
    table: name,
    sourcePath: absPath,
    dialect,
    loadedAt: new Date().toISOString(),
  });
  writeSessions();

  return name;
}

export async function executeQuery(sql: string): Promise<QueryResult> {
  const d = getDb();

  // Get column metadata via DESCRIBE
  let columns: QueryColumn[] = [];
  try {
    const desc = await d.all(`DESCRIBE ${sql}`);
    columns = desc.map((row: any) => ({
      name: String(row.column_name),
      type: String(row.column_type),
    }));
  } catch {
    // DESCRIBE may fail for non-SELECT statements, that's OK
  }

  // Run the actual query
  const rows = await d.all(sql);

  // If DESCRIBE failed but we have rows, infer column names
  if (columns.length === 0 && rows.length > 0) {
    columns = Object.keys(rows[0]).map(name => ({ name, type: 'VARCHAR' }));
  }

  return { columns, rows, rowCount: rows.length };
}

export async function getTableColumns(tableName: string): Promise<{ columns: QueryColumn[]; rowCount: number }> {
  const d = getDb();

  const colRows = await d.all(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${lit(tableName)}' AND table_schema = 'main' ORDER BY ordinal_position`
  );

  const columns: QueryColumn[] = colRows.map((r: any) => ({
    name: String(r.column_name),
    type: String(r.data_type),
  }));

  const countRows = await d.all(`SELECT COUNT(*) as cnt FROM ${q(tableName)}`);
  const rowCount = Number((countRows[0] as any)?.cnt ?? 0);

  return { columns, rowCount };
}

export async function getSchema(): Promise<TableInfo[]> {
  const tableNames = await listTables();
  const tables: TableInfo[] = [];
  for (const tableName of tableNames) {
    const { columns, rowCount } = await getTableColumns(tableName);
    tables.push({ name: tableName, columns, rowCount });
  }
  return tables;
}

export async function listTables(): Promise<string[]> {
  const d = getDb();
  const rows = await d.all(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE'"
  );
  return rows.map((r: any) => String(r.table_name));
}

export async function dropTable(table: string): Promise<void> {
  const d = getDb();
  const tables = await listTables();
  if (!tables.includes(table)) {
    throw new Error(`Table "${table}" is not loaded. Loaded tables: ${tables.length ? tables.join(', ') : '(none)'}`);
  }
  await d.exec(`DROP TABLE IF EXISTS ${q(table)}`);
  tableMeta.delete(table);
  writeSessions();
}

export async function updateRows(
  table: string,
  setClauses: Record<string, unknown>,
  whereClause: string
): Promise<number> {
  const d = getDb();

  const setEntries = Object.entries(setClauses)
    .map(([col, val]) => {
      const sqlVal = typeof val === 'string' ? `'${lit(val)}'` :
                     val === null ? 'NULL' : String(val);
      return `${q(col)} = ${sqlVal}`;
    })
    .join(', ');

  const sql = `UPDATE ${q(table)} SET ${setEntries} WHERE ${whereClause}`;
  const result = await d.all(sql);
  // DuckDB UPDATE returns [{Count: N}]
  return Number((result[0] as any)?.Count ?? (result[0] as any)?.count ?? 0);
}

export async function insertRow(
  table: string,
  values: Record<string, unknown>
): Promise<void> {
  const d = getDb();

  const cols = Object.keys(values).map(c => q(c)).join(', ');
  const vals = Object.values(values)
    .map(val => {
      if (val === null || val === undefined) return 'NULL';
      if (typeof val === 'string') return `'${lit(val)}'`;
      return String(val);
    })
    .join(', ');

  await d.exec(`INSERT INTO ${q(table)} (${cols}) VALUES (${vals})`);
}

export async function deleteRows(table: string, whereClause: string): Promise<number> {
  const d = getDb();
  const result = await d.all(`DELETE FROM ${q(table)} WHERE ${whereClause}`);
  // DuckDB DELETE returns [{Count: N}]
  return Number((result[0] as any)?.Count ?? (result[0] as any)?.count ?? 0);
}

// --- Saving ---

export async function saveTable(
  table: string,
  filePath?: string,
  opts: SaveTableOptions = {}
): Promise<{ filePath: string; delimiter: string; header: boolean; quoteStyle: string }> {
  const d = getDb();
  const meta = tableMeta.get(table);

  const target = filePath ?? meta?.sourcePath;
  if (!target) {
    throw new Error(
      `No file path given and no source path known for table "${table}". ` +
      `Pass filePath explicitly (the table was not created by load_csv).`
    );
  }
  const absPath = path.resolve(target);

  // Each option defaults to the stored dialect, so a file round-trips in its original format.
  const delimiter = opts.delimiter ?? meta?.dialect.delimiter ?? ',';
  const header = opts.header ?? meta?.dialect.hasHeader ?? true;
  const quoteStyle = opts.quoteStyle ?? 'as-needed';
  const dateFormat = opts.dateFormat ?? meta?.dialect.dateFormat;

  const copyOptions: string[] = ['FORMAT CSV'];
  copyOptions.push(`DELIMITER '${lit(delimiter)}'`);
  if (header) copyOptions.push('HEADER');
  if (quoteStyle === 'always') copyOptions.push('FORCE_QUOTE *');
  if (dateFormat) copyOptions.push(`DATEFORMAT '${lit(dateFormat)}'`);

  await d.exec(`COPY ${q(table)} TO '${lit(absPath)}' (${copyOptions.join(', ')})`);

  return { filePath: absPath, delimiter, header, quoteStyle };
}

// --- Profiling ---

export interface ColumnProfile {
  column: string;
  type: string;
  total_rows: number;
  null_count: number;
  empty_string_count: number;
  whitespace_only_count: number;
  distinct_count: number;
  max_len?: number;
  min_len?: number;
  numeric_castable_count?: number;
  min?: unknown;
  max?: unknown;
  avg?: number;
}

/**
 * Profile columns of a loaded table using a SINGLE aggregate scan.
 * Aliases are positional (c0_nulls, c1_nulls, ...) so columns whose names
 * would slug to the same identifier cannot collide.
 */
export async function profileTable(table: string, columns?: string[]): Promise<ColumnProfile[]> {
  const d = getDb();
  const { columns: allCols } = await getTableColumns(table);
  if (allCols.length === 0) throw new Error(`Table "${table}" not found or has no columns.`);

  const byName = new Map(allCols.map(c => [c.name, c]));
  const targets = columns && columns.length ? columns.map(name => {
    const col = byName.get(name);
    if (!col) {
      throw new Error(`Column "${name}" not found in table "${table}". Available: ${allCols.map(c => c.name).join(', ')}`);
    }
    return col;
  }) : allCols;

  const selects: string[] = ['COUNT(*) AS total_rows'];
  targets.forEach((col, i) => {
    const c = q(col.name);
    selects.push(`SUM(CASE WHEN ${c} IS NULL THEN 1 ELSE 0 END) AS c${i}_nulls`);
    selects.push(`COUNT(DISTINCT ${c}) AS c${i}_distinct`);

    if (isVarcharType(col.type)) {
      selects.push(`SUM(CASE WHEN ${c} = '' THEN 1 ELSE 0 END) AS c${i}_empty`);
      selects.push(`SUM(CASE WHEN trim(${c}) = '' AND ${c} <> '' THEN 1 ELSE 0 END) AS c${i}_ws`);
      selects.push(`MAX(LENGTH(${c})) AS c${i}_maxlen`);
      selects.push(`MIN(LENGTH(${c})) AS c${i}_minlen`);
      selects.push(`COUNT(TRY_CAST(${c} AS BIGINT)) AS c${i}_numcast`);
    } else {
      // Non-VARCHAR columns can never hold '' — the cast would be a no-op cost.
      selects.push(`0 AS c${i}_empty`);
      selects.push(`0 AS c${i}_ws`);
    }

    if (isNumericType(col.type)) {
      selects.push(`MIN(${c}) AS c${i}_min`);
      selects.push(`MAX(${c}) AS c${i}_max`);
      selects.push(`AVG(${c}) AS c${i}_avg`);
    }
  });

  const rows = await d.all(`SELECT ${selects.join(', ')} FROM ${q(table)}`);
  const r = (rows[0] ?? {}) as Record<string, unknown>;

  // duckdb-async returns counts as BigInt — Number() them or JSON.stringify throws.
  const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
  const optNum = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));

  const total = num(r.total_rows);

  return targets.map((col, i) => {
    const profile: ColumnProfile = {
      column: col.name,
      type: col.type,
      total_rows: total,
      null_count: num(r[`c${i}_nulls`]),
      empty_string_count: num(r[`c${i}_empty`]),
      whitespace_only_count: num(r[`c${i}_ws`]),
      distinct_count: num(r[`c${i}_distinct`]),
    };

    if (isVarcharType(col.type)) {
      profile.max_len = optNum(r[`c${i}_maxlen`]);
      profile.min_len = optNum(r[`c${i}_minlen`]);
      profile.numeric_castable_count = num(r[`c${i}_numcast`]);
    }

    if (isNumericType(col.type)) {
      const mn = r[`c${i}_min`];
      const mx = r[`c${i}_max`];
      profile.min = typeof mn === 'bigint' ? Number(mn) : mn;
      profile.max = typeof mx === 'bigint' ? Number(mx) : mx;
      profile.avg = optNum(r[`c${i}_avg`]);
    }

    return profile;
  });
}

export interface FileProfile {
  filePath: string;
  dialect: CsvDialect;
  rowCount: number;
  fieldCount: number;
  columns: { name: string; type: string; max_len: number | undefined; exceedsThreshold: boolean }[];
  flagged: string[];
  maxLenThreshold: number;
}

/** Scan a file WITHOUT creating a table — a pre-load reconnaissance pass. */
export async function profileFile(filePath: string, maxLenThreshold = 50): Promise<FileProfile> {
  const d = getDb();
  const absPath = path.resolve(filePath);
  const dialect = await sniffCsv(absPath);

  // Read every field as VARCHAR so LENGTH() reflects the raw text width on disk.
  const readArgs = [
    `'${lit(absPath)}'`,
    `delim='${lit(dialect.delimiter)}'`,
    `quote='${lit(dialect.quote)}'`,
    `escape='${lit(dialect.escape)}'`,
    `header=${dialect.hasHeader ? 'true' : 'false'}`,
    'all_varchar=true',
  ];
  if (dialect.skipRows > 0) readArgs.push(`skip=${Math.trunc(dialect.skipRows)}`);
  const source = `read_csv(${readArgs.join(', ')})`;

  const desc = await d.all(`DESCRIBE SELECT * FROM ${source}`);
  const cols = desc.map((row: any) => ({ name: String(row.column_name), type: String(row.column_type) }));

  const selects = ['COUNT(*) AS total_rows'];
  cols.forEach((c, i) => selects.push(`MAX(LENGTH(${q(c.name)})) AS c${i}_maxlen`));

  const rows = await d.all(`SELECT ${selects.join(', ')} FROM ${source}`);
  const r = (rows[0] ?? {}) as Record<string, unknown>;

  // Report the sniffed types, not the all_varchar ones we forced for width measurement.
  const sniffedTypes = new Map<string, string>();
  try {
    const sn = await d.all(`SELECT Columns FROM sniff_csv('${lit(absPath)}')`);
    for (const c of ((sn[0] as any)?.Columns ?? []) as { name: string; type: string }[]) {
      sniffedTypes.set(String(c.name), String(c.type));
    }
  } catch {
    // Types are a nicety here — width/flagging is the point.
  }

  const columns = cols.map((c, i) => {
    const maxLen = r[`c${i}_maxlen`] === null || r[`c${i}_maxlen`] === undefined ? undefined : Number(r[`c${i}_maxlen`]);
    return {
      name: c.name,
      type: sniffedTypes.get(c.name) ?? c.type,
      max_len: maxLen,
      exceedsThreshold: maxLen !== undefined && maxLen > maxLenThreshold,
    };
  });

  return {
    filePath: absPath,
    dialect,
    rowCount: Number(r.total_rows ?? 0),
    fieldCount: cols.length,
    columns,
    flagged: columns.filter(c => c.exceedsThreshold).map(c => c.name),
    maxLenThreshold,
  };
}

// --- Diffing ---

export interface ColumnDiff {
  column: string;
  aBlankBPopulated: number;
  bBlankAPopulated: number;
  bothPopulatedDiffer: number;
}

export interface TableDiff {
  tableA: string;
  tableB: string;
  keyCol: string;
  onlyInA: string[];
  onlyInB: string[];
  shared: string[];
  matchedRows: number;
  keysOnlyInA: number;
  keysOnlyInB: number;
  columnDiffs: ColumnDiff[];
}

export async function diffTables(tableA: string, tableB: string, keyCol: string): Promise<TableDiff> {
  const d = getDb();
  const { columns: colsA } = await getTableColumns(tableA);
  const { columns: colsB } = await getTableColumns(tableB);

  if (colsA.length === 0) throw new Error(`Table "${tableA}" not found or has no columns.`);
  if (colsB.length === 0) throw new Error(`Table "${tableB}" not found or has no columns.`);

  const namesA = colsA.map(c => c.name);
  const namesB = colsB.map(c => c.name);

  if (!namesA.includes(keyCol)) {
    throw new Error(`Key column "${keyCol}" does not exist in table "${tableA}". Columns: ${namesA.join(', ')}`);
  }
  if (!namesB.includes(keyCol)) {
    throw new Error(`Key column "${keyCol}" does not exist in table "${tableB}". Columns: ${namesB.join(', ')}`);
  }

  const setB = new Set(namesB);
  const setA = new Set(namesA);
  const onlyInA = namesA.filter(n => !setB.has(n));
  const onlyInB = namesB.filter(n => !setA.has(n));
  const shared = namesA.filter(n => setB.has(n) && n !== keyCol);

  const k = q(keyCol);

  // Key overlap, computed independently of the column comparison.
  const overlapRows = await d.all(`
    SELECT
      (SELECT COUNT(*) FROM ${q(tableA)} a JOIN ${q(tableB)} b ON a.${k} = b.${k}) AS matched,
      (SELECT COUNT(*) FROM ${q(tableA)} a WHERE a.${k} NOT IN (SELECT ${k} FROM ${q(tableB)} WHERE ${k} IS NOT NULL)) AS only_a,
      (SELECT COUNT(*) FROM ${q(tableB)} b WHERE b.${k} NOT IN (SELECT ${k} FROM ${q(tableA)} WHERE ${k} IS NOT NULL)) AS only_b
  `);
  const ov = (overlapRows[0] ?? {}) as Record<string, unknown>;

  let columnDiffs: ColumnDiff[] = [];
  if (shared.length > 0) {
    const selects: string[] = [];
    shared.forEach((name, i) => {
      // Compare as text so differing-but-compatible column types still diff cleanly.
      const av = `CAST(a.${q(name)} AS VARCHAR)`;
      const bv = `CAST(b.${q(name)} AS VARCHAR)`;
      const aBlank = `(${av} IS NULL OR ${av} = '')`;
      const bBlank = `(${bv} IS NULL OR ${bv} = '')`;
      selects.push(`SUM(CASE WHEN ${aBlank} AND NOT ${bBlank} THEN 1 ELSE 0 END) AS c${i}_a_blank`);
      selects.push(`SUM(CASE WHEN ${bBlank} AND NOT ${aBlank} THEN 1 ELSE 0 END) AS c${i}_b_blank`);
      selects.push(`SUM(CASE WHEN NOT ${aBlank} AND NOT ${bBlank} AND ${av} <> ${bv} THEN 1 ELSE 0 END) AS c${i}_differ`);
    });

    const rows = await d.all(`
      SELECT ${selects.join(', ')}
      FROM ${q(tableA)} a JOIN ${q(tableB)} b ON a.${k} = b.${k}
    `);
    const r = (rows[0] ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

    columnDiffs = shared.map((name, i) => ({
      column: name,
      aBlankBPopulated: num(r[`c${i}_a_blank`]),
      bBlankAPopulated: num(r[`c${i}_b_blank`]),
      bothPopulatedDiffer: num(r[`c${i}_differ`]),
    }));
  }

  return {
    tableA,
    tableB,
    keyCol,
    onlyInA,
    onlyInB,
    shared,
    matchedRows: Number(ov.matched ?? 0),
    keysOnlyInA: Number(ov.only_a ?? 0),
    keysOnlyInB: Number(ov.only_b ?? 0),
    columnDiffs,
  };
}

export async function close(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}
