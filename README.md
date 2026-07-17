# SQL CSV Chomper

A VS Code extension and MCP server for querying and editing CSV/TSV files using SQL, powered by DuckDB.

**[Install from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=MarkSawczuk.sql-csv-chomper)**

## Features

- **Custom CSV Editor** — Open delimited files in VS Code with a full SQL IDE layout
- **Full SQL Support** — Write and execute DuckDB SQL against your CSV files
- **Format Preservation** — The source delimiter, quoting and header are detected on load and reused on save, so a pipe- or tab-delimited file is never silently rewritten as comma-delimited
- **Load Options** — Override the column delimiter, row delimiter, header, quoting or encoding when detection gets it wrong, and re-read the file in place
- **Virtual Scrolling** — Handles 500K+ rows with chunked loading
- **Resizable Columns** — Drag any column edge; double-click the handle to auto-fit
- **Column Filtering** — Excel-style filter panels with value checkboxes, search, date histograms
- **Column Profiling** — Distinct, null, whitespace-only and max-length stats per column
- **Inline Editing** — Double-click cells to edit, save back to disk
- **Column Operations** — Rename, insert, delete columns via right-click
- **Find & Replace** — Regex and case-sensitive search across columns
- **Save As** — Export with custom delimiter, quoting, row numbers
- **Multi-Table Support** — Load multiple files and JOIN across them
- **MCP Server** — Expose CSV querying, profiling and table diffing to Claude, Copilot, and other AI assistants

## Project Structure

```
packages/
  extension/     # VS Code extension (custom editor provider)
  webapp/        # React editor UI (Monaco, TanStack Table, DuckDB WASM)
  mcp-server/    # MCP server for LLM integration (native DuckDB)
```

## Development

```bash
npm install
npm run build        # Build all packages
npm run dev          # Run webapp standalone for development
```

Press **F5** in VS Code to launch the Extension Development Host for testing.

## Publishing

```bash
cd packages/extension
npx @vscode/vsce publish --no-dependencies
```

## MCP Server

The MCP server lets AI assistants load, query, edit, and save CSV files via SQL. It auto-installs the native DuckDB binary on first run.

See the [extension README](packages/extension/README.md) for full setup instructions (Claude Code, Copilot, terminal).

### Quick setup (Claude Code)

```bash
claude mcp add sql-csv-chomper --scope user -- npx -y sql-csv-chomper-mcp
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `load_csv` / `unload_csv` | Load a delimited file as a named table (dialect detected and overridable), or drop it |
| `execute_sql` | Run SQL queries against loaded tables |
| `list_tables` / `list_columns` / `get_schema` | Inspect loaded data |
| `profile_table` / `profile_file` | Column stats, or scan a file before loading it |
| `diff_tables` | Schema-aware diff of two tables on a key column |
| `update_rows` / `insert_row` / `delete_rows` | Edit data |
| `save_table` | Write a table back out, in its original dialect by default |
| `list_remembered_tables` / `reload_remembered_tables` | Re-load tables from a previous session |
| `set_editor_sql` / `run_editor_query` | Push SQL into the VS Code editor |

See the [MCP server README](packages/mcp-server/README.md) for details, including a note on how DuckDB
treats empty CSV fields as `NULL`.

## License

[MIT](LICENSE)
