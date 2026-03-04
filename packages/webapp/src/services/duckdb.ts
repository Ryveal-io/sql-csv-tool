import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import type { QueryColumn, QueryResult } from '../types/query';

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;

// Track loaded tables: tableName -> originalFileName
const loadedTables = new Map<string, string>();

function tableNameFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '');
  return stem.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'data';
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

export async function loadCsvFromBytes(
  fileName: string,
  content: Uint8Array
): Promise<string> {
  if (!db || !conn) throw new Error('DuckDB not initialized');

  const tableName = tableNameFromFileName(fileName);
  await db.registerFileBuffer(fileName, content);
  await conn.query(`
    CREATE OR REPLACE TABLE "${tableName}" AS
    SELECT * FROM read_csv_auto('${fileName}')
  `);

  loadedTables.set(tableName, fileName);
  return tableName;
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

export function getLoadedTables(): Map<string, string> {
  return new Map(loadedTables);
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
  await conn.query(`COPY "${table}" TO 'export.csv' (FORMAT CSV, HEADER)`);
  const buffer = await db.copyFileToBuffer('export.csv');
  return buffer;
}

export async function dropTable(tableName: string): Promise<void> {
  if (!conn) throw new Error('DuckDB not connected');
  await conn.query(`DROP TABLE IF EXISTS "${tableName}"`);
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

export async function saveTableToBytes(tableName: string): Promise<Uint8Array> {
  if (!conn || !db) throw new Error('DuckDB not connected');
  await conn.query(`COPY "${tableName}" TO 'save_export.csv' (FORMAT CSV, HEADER)`);
  return await db.copyFileToBuffer('save_export.csv');
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
}

export async function getColumnQuickStats(
  tableName: string,
  columns: { name: string }[]
): Promise<Map<string, ColumnQuickStats>> {
  if (!conn) throw new Error('DuckDB not connected');
  const tbl = `"${tableName.replace(/"/g, '""')}"`;
  // Build a single query that gets distinct + null counts for all columns
  const selects = columns.map(c => {
    const col = `"${c.name.replace(/"/g, '""')}"`;
    const safe = c.name.replace(/[^a-zA-Z0-9_]/g, '_');
    return `COUNT(DISTINCT ${col}) as dist_${safe}, COUNT(*) - COUNT(${col}) as null_${safe}`;
  });
  const result = await conn.query(
    `SELECT COUNT(*) as total, ${selects.join(', ')} FROM ${tbl}`
  );
  const total = Number(result.getChild('total')?.get(0) ?? 0);
  const stats = new Map<string, ColumnQuickStats>();
  for (const c of columns) {
    const safe = c.name.replace(/[^a-zA-Z0-9_]/g, '_');
    stats.set(c.name, {
      distinctCount: Number(result.getChild(`dist_${safe}`)?.get(0) ?? 0),
      nullCount: Number(result.getChild(`null_${safe}`)?.get(0) ?? 0),
      totalRows: total,
    });
  }
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
  loadedTables.set(tableName, loadedTables.get(tableName) ?? tableName);
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
  if (!conn || !db) throw new Error('DuckDB not connected');

  const tbl = `"${tableName.replace(/"/g, '""')}"`;
  const copyOptions: string[] = ['FORMAT CSV'];

  copyOptions.push(`DELIMITER '${options.delimiter.replace(/'/g, "''")}'`);

  if (options.includeHeader) {
    copyOptions.push('HEADER');
  }

  if (options.quoteStyle === 'always') {
    copyOptions.push('FORCE_QUOTE *');
  }
  // 'as-needed' is DuckDB default, 'never' we handle by setting quote to empty-ish

  let sourceExpr: string;
  if (options.includeRowNumbers) {
    sourceExpr = `(SELECT ROW_NUMBER() OVER () as row_num, * FROM ${tbl})`;
  } else {
    sourceExpr = tbl;
  }

  const fileName = 'save_as_export.csv';
  await conn.query(`COPY ${sourceExpr} TO '${fileName}' (${copyOptions.join(', ')})`);
  return await db.copyFileToBuffer(fileName);
}

export function getConnection(): duckdb.AsyncDuckDBConnection | null {
  return conn;
}
