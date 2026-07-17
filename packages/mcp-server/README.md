# SQL CSV Chomper — MCP Server

Give your AI assistant direct SQL access to CSV files. Load, query, edit, and save — no scripts, no round-trips.

Powered by [DuckDB](https://duckdb.org/). Works with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), GitHub Copilot, and any [MCP](https://modelcontextprotocol.io/)-compatible client.

> **Want the full visual experience?** Install the [SQL CSV Chomper VS Code extension](https://marketplace.visualstudio.com/items?itemName=MarkSawczuk.sql-csv-chomper) for a built-in SQL editor with column filtering, inline editing, virtual scrolling, and more.

## Quick start

### Claude Code

```bash
claude mcp add sql-csv-chomper --scope user -- npx -y sql-csv-chomper-mcp
```

That's it. Claude can now load and query your CSV files directly.

### Claude Code (from VS Code)

1. Install the [SQL CSV Chomper extension](https://marketplace.visualstudio.com/items?itemName=MarkSawczuk.sql-csv-chomper)
2. `Cmd+Shift+P` → **"SQL CSV Chomper: Configure MCP for Claude CLI"**
3. Choose **User** (all projects) or **Project** (this workspace)

### Other MCP clients

Run the server over stdio:

```bash
npx -y sql-csv-chomper-mcp
```

The server communicates via the [Model Context Protocol](https://modelcontextprotocol.io/) over stdin/stdout.

## Available tools

| Tool | Description |
|------|-------------|
| `load_csv` | Load a CSV/TSV/delimited file as a named table. Detects the dialect and remembers it; every option can be overridden |
| `unload_csv` | Drop a table and forget its metadata |
| `execute_sql` | Run any DuckDB SQL query |
| `list_tables` | List all loaded tables |
| `list_columns` | Get column names and types for a table |
| `get_schema` | Full schema for all tables |
| `profile_table` | Per-column stats: nulls, empty vs whitespace-only, min/max length, numeric-castable count, distinct |
| `profile_file` | Scan a file *before* loading it — dialect, row/field counts, and columns whose length looks suspicious |
| `diff_tables` | Schema-aware diff of two tables on a key column: columns only in one side, and blank-vs-populated counts |
| `update_rows` | Update rows matching a WHERE condition |
| `insert_row` | Insert a new row |
| `delete_rows` | Delete rows matching a WHERE condition |
| `save_table` | Write a table back out. With no `filePath`, saves to the original file **in its original dialect** |
| `list_remembered_tables` | Tables remembered from previous sessions (metadata only) |
| `reload_remembered_tables` | Re-load remembered tables using their stored dialect |
| `set_editor_sql` | Push SQL into the VS Code editor (requires extension) |
| `run_editor_query` | Set and execute SQL in the VS Code editor (requires extension) |

## What can your AI do with this?

- **"Load sales.csv and show me the top 10 customers by revenue"**
- **"Join orders.csv with products.csv and find items with no orders"**
- **"Update all rows where status is 'pending' to 'active'"**
- **"Save the filtered results to cleaned_data.csv"**
- **"This pipe-delimited file has fields that look too long — profile it before I load it"**
- **"Which columns are populated in the reference file but blank in ours?"**

DuckDB's full SQL is available — joins, window functions, CTEs, aggregations, regex, date math, and more.

## Format preservation

`load_csv` detects the delimiter, quote, escape and header via DuckDB's `sniff_csv()` and stores them
against the table. `save_table` reuses them, so a pipe-delimited or tab-delimited file is written back
the way it arrived rather than silently converted to comma-delimited. Fields containing the delimiter
are re-quoted on the way out, so they survive the round trip.

Pass `delimiter`, `newline`, `header`, `quote`, `escape`, `skipRows` or `encoding` to `load_csv` when
detection gets it wrong, and the same options to `save_table` when you genuinely want to convert.

## A note on empty fields and NULL

**DuckDB reads an empty CSV field as `NULL`, not as an empty string** — and it does the same for a
quoted empty field (`""`). The two are indistinguishable once loaded, because the CSV format itself
has no way to tell them apart. Query them with `IS NULL`; `= ''` will not match.

This matters when a downstream consumer treats `None` and `''` differently. `profile_table` reports
`null_count` alongside `whitespace_only_count` so you can at least tell a truly blank field from one
holding a space — a distinction DuckDB *does* preserve.

## How it works

- `npx` downloads the package and installs DuckDB's native binary for your platform automatically
- The server starts over stdio and speaks MCP
- Files are loaded into an in-memory DuckDB instance
- Table metadata (path + dialect, never row data) is remembered in `~/.sql-csv-chomper/sessions.json`, keyed by working directory
- All queries run locally — nothing leaves your machine

## Upgrading

```bash
claude mcp remove sql-csv-chomper
claude mcp add sql-csv-chomper --scope user -- npx -y sql-csv-chomper-mcp
```

## Requirements

- Node.js 18+

## Related

- [SQL CSV Chomper VS Code extension](https://marketplace.visualstudio.com/items?itemName=MarkSawczuk.sql-csv-chomper) — Visual SQL editor for CSV files with column filtering, inline editing, and virtual scrolling
- [GitHub repo](https://github.com/Ryveal-io/sql-csv-chomper)

## License

[MIT](https://github.com/Ryveal-io/sql-csv-chomper/blob/main/LICENSE)
