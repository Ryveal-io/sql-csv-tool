import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as db from './duckdb-service.js';
import * as bridge from './bridge-client.js';

const INSTRUCTIONS = `
This server provides SQL access to CSV/TSV data files via DuckDB.

## DuckDB SQL Highlights
- FROM-first syntax: \`FROM my_table SELECT col1, col2\` (SELECT is optional)
- GROUP BY ALL: automatically groups by all non-aggregate columns
- ORDER BY ALL: orders by all columns
- SELECT * EXCLUDE (col1, col2): select all columns except specified ones
- SELECT * REPLACE (expr AS col): select all but replace a column's expression
- COLUMNS('regex'): select columns matching a pattern, e.g. \`SELECT COLUMNS('.*_id') FROM t\`
- QUALIFY: filter window function results — \`SELECT *, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn FROM employees QUALIFY rn = 1\`
- ILIKE for case-insensitive matching, regexp_matches() for regex
- Complex types: LIST, STRUCT, MAP are first-class — use dot notation for struct fields
- SUMMARIZE: quick stats — \`SUMMARIZE SELECT * FROM table\`
- DESCRIBE: show column types — \`DESCRIBE table\` or \`DESCRIBE SELECT ...\`
- Friendly SQL: \`SELECT * FROM 'file.csv'\` reads files directly without loading

## Data Quality — use profile_table, don't hand-write stats
- profile_table: per-column type, total/null/empty-string/whitespace-only counts, distinct count,
  min/max length, numeric-castable count, and min/max/avg for numeric columns — all in ONE scan.
  Prefer it over hand-writing SUMMARIZE or a pile of COUNT(CASE WHEN ...) expressions.
- profile_file: scan a file's dialect, row/field counts and column widths BEFORE loading it.
- diff_tables: schema-aware comparison of two tables joined on a key column.

## IMPORTANT: empty values become NULL on read
DuckDB maps BOTH unquoted empty fields (\`a||b\`) and quoted empty fields (\`a|""|b\`) to NULL when
reading CSV. This is standard DuckDB behavior and is NOT a bug.
Consequences you must report accurately:
- empty_string_count is almost always 0 for freshly loaded CSV data — the empties are NULLs.
  Look at null_count instead. Do NOT tell the user "there are no empty values" because
  empty_string_count is 0; say the empty fields were read as NULL.
- \`WHERE col = ''\` will not match blank CSV fields. Use \`col IS NULL\`, or
  \`(col IS NULL OR col = '')\` to cover both.
- whitespace_only_count counts fields like "   " that are NOT empty and NOT NULL — these
  survive as real strings and are a common data-quality problem worth flagging.

## Dialect preservation
- load_csv sniffs the dialect (delimiter, quote, escape, header) and remembers it per table.
- save_table with no filePath writes back to the ORIGINAL file in its ORIGINAL dialect —
  a pipe-delimited file saves as pipe-delimited, not comma. Override per-call if needed.
- Loaded tables are remembered across restarts (metadata only, never data), keyed by working
  directory: list_remembered_tables / reload_remembered_tables.

## Row-based Editing
To edit specific rows safely:
1. Find rows: \`SELECT rowid, * FROM "table" WHERE condition\`
2. Update: use update_rows tool with \`where: "rowid = N"\`
3. Delete: use delete_rows tool with \`where: "rowid = N"\`
4. Insert: use insert_row tool with column-value pairs
Always SELECT with rowid first to identify exact rows before modifying.

## Multi-file Querying
- load_csv creates a named table from each file (e.g., employees.csv becomes "employees")
- Query across tables: \`SELECT * FROM "employees" e JOIN "departments" d ON e.dept_id = d.id\`
- Glob patterns work directly: \`SELECT * FROM read_csv_auto('data/*.csv')\`
- No need to load files for glob/direct reads — DuckDB handles them on the fly
- UNION across files: \`SELECT * FROM read_csv_auto('logs_2024_*.csv')\`

## Editor Bridge (VS Code only)
- set_editor_sql: pushes SQL into the VS Code editor pane (visual)
- run_editor_query: sets SQL AND executes it, showing results in the editor
- These only work when connected to VS Code — use execute_sql for direct results
- Prefer execute_sql for data retrieval, run_editor_query for showing results to the user
`.trim();

const server = new McpServer(
  { name: 'sql-csv-tool', version: '0.4.0' },
  { instructions: INSTRUCTIONS }
);

// --- Data Tools ---

server.tool(
  'load_csv',
  'Load a CSV/TSV/delimited file from disk into DuckDB as a named table. The dialect (delimiter, quote, escape, header) is auto-detected and remembered, so save_table can write the file back in its original format. Any option you pass explicitly overrides the detected value. The table name defaults to the filename (e.g., employees.csv becomes "employees").',
  {
    filePath: z.string().describe('Absolute or relative path to the CSV/TSV file'),
    tableName: z.string().optional().describe('Optional table name (defaults to filename stem)'),
    delimiter: z.string().optional().describe('Field delimiter override, e.g. "|" or "\\t" (default: auto-detected)'),
    header: z.boolean().optional().describe('Whether the first row is a header (default: auto-detected). Pass false for headerless files that sniff wrong.'),
    quote: z.string().optional().describe('Quote character override; pass "" for none (default: auto-detected)'),
    escape: z.string().optional().describe('Escape character override; pass "" for none (default: auto-detected)'),
    newline: z.enum(['\\r', '\\n', '\\r\\n']).optional().describe('Row delimiter override (default: auto-detected). Only these three tokens are accepted.'),
    skipRows: z.number().int().min(0).optional().describe('Number of leading rows to skip before the header'),
    encoding: z.string().optional().describe('File encoding: utf-8 (default), utf-16, or latin-1'),
    allVarchar: z.boolean().optional().describe('Read every column as VARCHAR, skipping type inference. Useful when type detection mangles data (e.g. leading-zero IDs).'),
    nullstr: z.string().optional().describe('String to treat as NULL, e.g. "NA" or "\\\\N"'),
    dateFormat: z.string().optional().describe('Date parsing format, e.g. "%d/%m/%Y"'),
    sampleSize: z.number().int().optional().describe('Rows to sample for type inference (-1 scans the whole file)'),
    ignoreErrors: z.boolean().optional().describe('Skip rows that fail to parse instead of erroring the whole load'),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ filePath, ...opts }) => {
    try {
      const name = await db.loadCsv(filePath, opts);
      const { columns, rowCount } = await db.getTableColumns(name);
      const meta = db.getTableMeta(name);
      const colList = columns.map(c => `  ${c.name} (${c.type})`).join('\n');

      let text = `Loaded "${filePath}" as table "${name}" (${rowCount} rows)\n`;
      if (meta) {
        const dl = meta.dialect;
        const show = (s: string) => (s === '' ? '(none)' : s === '\t' ? '\\t' : s);
        text += `\nDialect: delimiter="${show(dl.delimiter)}" quote="${show(dl.quote)}" escape="${show(dl.escape)}" header=${dl.hasHeader} newline="${dl.newline}"`;
        if (dl.skipRows > 0) text += ` skipRows=${dl.skipRows}`;
        if (dl.encoding) text += ` encoding=${dl.encoding}`;
        text += `\nsave_table("${name}") with no filePath writes back to this file in this dialect.\n`;
      }
      text += `\nColumns:\n${colList}\n\nYou can now query it with: SELECT * FROM "${name}" LIMIT 10`;
      text += `\nNote: empty CSV fields are read as NULL by DuckDB — use "IS NULL", not "= ''".`;

      return { content: [{ type: 'text', text }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error loading CSV: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  }
);

server.tool(
  'execute_sql',
  'Execute a SQL query against loaded tables in DuckDB. Returns column names, types, and row data. Use load_csv first to load files. Supports full DuckDB SQL syntax including joins, aggregations, window functions, etc.',
  {
    sql: z.string().describe('The SQL query to execute'),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ sql }) => {
    try {
      const result = await db.executeQuery(sql);
      const header = result.columns.map(c => c.name).join(' | ');
      const types = result.columns.map(c => c.type).join(' | ');
      const separator = result.columns.map(c => '-'.repeat(Math.max(c.name.length, c.type.length))).join('-+-');

      let tableStr = `${header}\n${types}\n${separator}\n`;

      const MAX_DISPLAY_ROWS = 1000;
      const displayRows = result.rows.slice(0, MAX_DISPLAY_ROWS);
      for (const row of displayRows) {
        const vals = result.columns.map(c => {
          const v = row[c.name];
          return v === null || v === undefined ? 'NULL' : String(v);
        });
        tableStr += vals.join(' | ') + '\n';
      }

      if (result.rowCount > MAX_DISPLAY_ROWS) {
        tableStr += `\n[Showing ${MAX_DISPLAY_ROWS} of ${result.rowCount} total rows. Add LIMIT or narrow your WHERE clause to see specific rows.]`;
      } else {
        tableStr += `\n${result.rowCount} row(s)`;
      }

      return { content: [{ type: 'text', text: tableStr }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `SQL Error: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  }
);

server.tool(
  'get_schema',
  'Get the schema of all loaded tables including column names, types, and row counts.',
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async () => {
    try {
      const schema = await db.getSchema();
      if (schema.length === 0) {
        return { content: [{ type: 'text', text: 'No tables loaded. Use load_csv to load a file first.' }] };
      }
      let text = '';
      for (const table of schema) {
        text += `Table: ${table.name} (${table.rowCount} rows)\n`;
        for (const col of table.columns) {
          text += `  ${col.name}: ${col.type}\n`;
        }
        text += '\n';
      }
      return { content: [{ type: 'text', text: text.trim() }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  }
);

server.tool(
  'list_tables',
  'List all tables currently loaded in DuckDB.',
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async () => {
    try {
      const tables = await db.listTables();
      if (tables.length === 0) {
        return { content: [{ type: 'text', text: 'No tables loaded. Use load_csv to load a file first.' }] };
      }
      return { content: [{ type: 'text', text: `Loaded tables:\n${tables.map(t => `  - ${t}`).join('\n')}` }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  }
);

server.tool(
  'list_columns',
  'Get column names, types, and row count for a specific table.',
  {
    table: z.string().describe('Table name to describe'),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ table }) => {
    try {
      const { columns, rowCount } = await db.getTableColumns(table);
      let text = `Table: ${table} (${rowCount} rows)\n`;
      for (const col of columns) {
        text += `  ${col.name}: ${col.type}\n`;
      }
      return { content: [{ type: 'text', text: text.trim() }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  }
);

// --- Modification Tools ---

server.tool(
  'update_rows',
  'Update rows in a table matching a WHERE condition. Use "SELECT rowid, * FROM table" to find specific row IDs, then update with "rowid = X". Example: update_rows(table: "employees", set: {"salary": 100000}, where: "rowid = 5")',
  {
    table: z.string().describe('Table name'),
    set: z.record(z.unknown()).describe('Column-value pairs to update, e.g. {"salary": 100000, "department": "Engineering"}'),
    where: z.string().describe('WHERE clause to identify rows, e.g. "rowid = 5" or "department = \'Sales\'"'),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async ({ table, set, where }) => {
    try {
      const changed = await db.updateRows(table, set, where);
      return { content: [{ type: 'text', text: `Updated ${changed} row(s) in "${table}".` }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  }
);

server.tool(
  'insert_row',
  'Insert a new row into a table.',
  {
    table: z.string().describe('Table name'),
    values: z.record(z.unknown()).describe('Column-value pairs for the new row, e.g. {"name": "Alice", "age": 30}'),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async ({ table, values }) => {
    try {
      await db.insertRow(table, values);
      return { content: [{ type: 'text', text: `Inserted 1 row into "${table}".` }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  }
);

server.tool(
  'delete_rows',
  'Delete rows from a table matching a WHERE condition. Use "SELECT rowid, * FROM table" to find specific row IDs first.',
  {
    table: z.string().describe('Table name'),
    where: z.string().describe('WHERE clause, e.g. "rowid = 5" or "status = \'inactive\'"'),
  },
  { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async ({ table, where }) => {
    try {
      const changed = await db.deleteRows(table, where);
      return { content: [{ type: 'text', text: `Deleted ${changed} row(s) from "${table}".` }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  }
);

server.tool(
  'save_table',
  'Export a table to a CSV file on disk. If filePath is omitted, the table is written back to the file it was loaded from. The original dialect (delimiter, quote, header) is preserved by default — a pipe-delimited file saves as pipe-delimited, not comma. Override any part per call.',
  {
    table: z.string().describe('Table name to export'),
    filePath: z.string().optional().describe('File path to write to (defaults to the path the table was loaded from)'),
    delimiter: z.string().optional().describe('Field delimiter override (defaults to the loaded dialect)'),
    header: z.boolean().optional().describe('Write a header row (defaults to the loaded dialect)'),
    quoteStyle: z.enum(['always', 'as-needed']).optional().describe('"as-needed" (default) quotes only when required; "always" force-quotes every field'),
    dateFormat: z.string().optional().describe('Date output format, e.g. "%d/%m/%Y"'),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ table, filePath, ...opts }) => {
    try {
      const res = await db.saveTable(table, filePath, opts);
      const show = (s: string) => (s === '' ? '(none)' : s === '\t' ? '\\t' : s);
      const wroteBack = !filePath ? ' (wrote back to source file)' : '';
      return {
        content: [{
          type: 'text',
          text: `Saved table "${table}" to "${res.filePath}"${wroteBack}.\n` +
                `Format: delimiter="${show(res.delimiter)}" header=${res.header} quoteStyle=${res.quoteStyle}`,
        }],
      };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  }
);

server.tool(
  'unload_csv',
  'Drop a loaded table from DuckDB, freeing its memory and forgetting its remembered metadata. Does NOT delete the file on disk.',
  {
    table: z.string().describe('Table name to drop'),
  },
  { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async ({ table }) => {
    try {
      await db.dropTable(table);
      const left = await db.listTables();
      return {
        content: [{
          type: 'text',
          text: `Dropped table "${table}". Remaining tables: ${left.length ? left.join(', ') : '(none)'}`,
        }],
      };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  }
);

// --- Profiling & Diff Tools ---

server.tool(
  'profile_table',
  'Profile the columns of a loaded table in a single scan: type, total rows, null count, empty-string count, whitespace-only count, distinct count, min/max length and numeric-castable count (VARCHAR columns), plus min/max/avg (numeric columns). Prefer this over hand-writing SUMMARIZE or COUNT(CASE WHEN ...) queries. NOTE: empty CSV fields are read as NULL by DuckDB, so empty_string_count is usually 0 and the blanks show up in null_count.',
  {
    table: z.string().describe('Table name to profile'),
    columns: z.array(z.string()).optional().describe('Specific columns to profile (defaults to all columns)'),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ table, columns }) => {
    try {
      const profiles = await db.profileTable(table, columns);
      let text = `Profile of "${table}" (${profiles[0]?.total_rows ?? 0} rows)\n`;
      text += `Note: empty CSV fields are read as NULL — blanks appear in null_count, not empty_string_count.\n`;
      for (const p of profiles) {
        text += `\n${p.column} (${p.type})\n`;
        text += `  nulls: ${p.null_count}  empty_string: ${p.empty_string_count}  whitespace_only: ${p.whitespace_only_count}  distinct: ${p.distinct_count}\n`;
        if (p.max_len !== undefined || p.min_len !== undefined) {
          text += `  length: min=${p.min_len ?? 'n/a'} max=${p.max_len ?? 'n/a'}\n`;
        }
        if (p.numeric_castable_count !== undefined) {
          text += `  numeric_castable: ${p.numeric_castable_count} of ${p.total_rows}\n`;
        }
        if (p.min !== undefined || p.max !== undefined) {
          text += `  range: min=${p.min} max=${p.max} avg=${p.avg}\n`;
        }
      }
      return { content: [{ type: 'text', text: text.trim() }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  }
);

server.tool(
  'profile_file',
  'Scan a CSV/TSV file WITHOUT loading it into a table. Reports the detected dialect, row count, field count, per-column maximum text width, and flags columns wider than a threshold. Use this to inspect an unfamiliar or large file before deciding how to load it.',
  {
    filePath: z.string().describe('Absolute or relative path to the CSV/TSV file'),
    maxLenThreshold: z.number().int().min(0).optional().describe('Flag columns whose max length exceeds this (default 50)'),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ filePath, maxLenThreshold }) => {
    try {
      const p = await db.profileFile(filePath, maxLenThreshold ?? 50);
      const show = (s: string) => (s === '' ? '(none)' : s === '\t' ? '\\t' : s);
      let text = `File: ${p.filePath}\n`;
      text += `Dialect: delimiter="${show(p.dialect.delimiter)}" quote="${show(p.dialect.quote)}" escape="${show(p.dialect.escape)}" header=${p.dialect.hasHeader} newline="${p.dialect.newline}"`;
      if (p.dialect.skipRows > 0) text += ` skipRows=${p.dialect.skipRows}`;
      text += `\nRows: ${p.rowCount}   Fields: ${p.fieldCount}\n\nColumns (max_len = widest raw text value):\n`;
      for (const c of p.columns) {
        text += `  ${c.name} (${c.type}): max_len=${c.max_len ?? 'n/a'}${c.exceedsThreshold ? '  <-- exceeds threshold' : ''}\n`;
      }
      text += p.flagged.length
        ? `\nFlagged (max_len > ${p.maxLenThreshold}): ${p.flagged.join(', ')}`
        : `\nNo columns exceed max_len ${p.maxLenThreshold}.`;
      return { content: [{ type: 'text', text }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  }
);

server.tool(
  'diff_tables',
  'Compare two loaded tables joined on a key column. Reports columns unique to each side, shared columns, key overlap, and for each shared column: how many joined rows are blank on one side but populated on the other, and how many are populated on both but differ. Blank means NULL or empty string.',
  {
    tableA: z.string().describe('First table name'),
    tableB: z.string().describe('Second table name'),
    keyCol: z.string().describe('Column to join on — must exist in both tables'),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ tableA, tableB, keyCol }) => {
    try {
      const d = await db.diffTables(tableA, tableB, keyCol);
      let text = `Diff: "${d.tableA}" vs "${d.tableB}" (joined on "${d.keyCol}")\n\n`;
      text += `Schema:\n`;
      text += `  only in ${d.tableA}: ${d.onlyInA.length ? d.onlyInA.join(', ') : '(none)'}\n`;
      text += `  only in ${d.tableB}: ${d.onlyInB.length ? d.onlyInB.join(', ') : '(none)'}\n`;
      text += `  shared (compared): ${d.shared.length ? d.shared.join(', ') : '(none)'}\n\n`;
      text += `Keys:\n  matched rows: ${d.matchedRows}\n  keys only in ${d.tableA}: ${d.keysOnlyInA}\n  keys only in ${d.tableB}: ${d.keysOnlyInB}\n`;

      if (d.columnDiffs.length) {
        text += `\nPer-column differences across ${d.matchedRows} matched row(s):\n`;
        for (const c of d.columnDiffs) {
          const clean = c.aBlankBPopulated === 0 && c.bBlankAPopulated === 0 && c.bothPopulatedDiffer === 0;
          text += `  ${c.column}: ${clean ? 'identical' :
            `blank in ${d.tableA} / populated in ${d.tableB}: ${c.aBlankBPopulated}; ` +
            `blank in ${d.tableB} / populated in ${d.tableA}: ${c.bBlankAPopulated}; ` +
            `both populated but differ: ${c.bothPopulatedDiffer}`}\n`;
        }
      }
      return { content: [{ type: 'text', text: text.trim() }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  }
);

// --- Session Memory Tools ---

server.tool(
  'list_remembered_tables',
  'List tables remembered from previous sessions in this working directory, with their source paths and detected dialects. Metadata only — no data is stored on disk. Use reload_remembered_tables to load them back.',
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async () => {
    try {
      const metas = db.listRememberedTables();
      if (metas.length === 0) {
        return { content: [{ type: 'text', text: 'No remembered tables for this working directory.' }] };
      }
      const show = (s: string) => (s === '' ? '(none)' : s === '\t' ? '\\t' : s);
      let text = `Remembered tables for ${process.cwd()}:\n`;
      for (const m of metas) {
        text += `\n  "${m.table}" <- ${m.sourcePath}\n`;
        text += `     delimiter="${show(m.dialect.delimiter)}" quote="${show(m.dialect.quote)}" header=${m.dialect.hasHeader}  (loaded ${m.loadedAt})\n`;
      }
      return { content: [{ type: 'text', text: text.trimEnd() }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  }
);

server.tool(
  'reload_remembered_tables',
  'Re-load every table remembered for this working directory, reusing each stored dialect. Files that no longer exist are skipped and reported rather than failing the call.',
  {},
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => {
    try {
      const results = await db.reloadRememberedTables();
      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No remembered tables for this working directory.' }] };
      }
      let text = '';
      for (const r of results) {
        if (r.status === 'reloaded') text += `  OK       "${r.table}" (${r.rowCount} rows) <- ${r.sourcePath}\n`;
        else if (r.status === 'missing') text += `  SKIPPED  "${r.table}" — ${r.message}: ${r.sourcePath}\n`;
        else text += `  FAILED   "${r.table}" — ${r.message}\n`;
      }
      const ok = results.filter(r => r.status === 'reloaded').length;
      return { content: [{ type: 'text', text: `Reloaded ${ok} of ${results.length} remembered table(s):\n${text.trimEnd()}` }] };
    } catch (err: unknown) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true };
    }
  }
);

// --- Editor Bridge Tools ---

server.tool(
  'set_editor_sql',
  'Set the SQL text in the VS Code SQL editor. Only works when connected to a VS Code extension instance.',
  {
    sql: z.string().describe('SQL text to set in the editor'),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ sql }) => {
    const result = await bridge.setSql(sql);
    if (result.success) {
      return { content: [{ type: 'text', text: `SQL set in editor:\n${sql}` }] };
    }
    return { content: [{ type: 'text', text: result.message || 'Failed to set SQL in editor.' }] };
  }
);

server.tool(
  'run_editor_query',
  'Set the SQL text in the VS Code SQL editor AND execute it, showing results in the results pane. Only works when connected to a VS Code extension instance.',
  {
    sql: z.string().describe('SQL text to set and run in the editor'),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ sql }) => {
    const result = await bridge.runQuery(sql);
    if (result.success) {
      return { content: [{ type: 'text', text: `Query set and executed in editor:\n${sql}` }] };
    }
    return { content: [{ type: 'text', text: result.message || 'Failed to run query in editor.' }] };
  }
);

// --- Start server ---

async function main() {
  await db.init();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error('SQL CSV Chomper MCP server started');
  if (bridge.isConnected()) {
    console.error(`VS Code bridge connected on port ${process.env.VSCODE_BRIDGE_PORT}`);
  } else {
    console.error('Running standalone (no VS Code bridge)');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
