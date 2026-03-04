# SQL CSV Chomper

**SQL tools for you. SQL tools for your LLM.**

Stop staring at raw CSV text. Stop copy-pasting into Excel. Stop writing throwaway Python scripts just to peek at your data. SQL CSV Chomper turns VS Code into a fast, lightweight SQL workbench for your data files — powered by [DuckDB WASM](https://duckdb.org/) running entirely in your browser. No server, no database, no nonsense.

Open any CSV. Write SQL. Get results. Chomp chomp.

![Open a CSV and click "Edit CSV" to launch the Chomper](https://raw.githubusercontent.com/Ryveal-io/sql-csv-tool/main/packages/extension/images/img_01_sql_chomper_button.png)

## Why?

Working with CSV files in VS Code has always been painful. Need to filter 500K rows? Join two CSVs? Edit a single value and save? Your options were Excel, a Python REPL, or a full database setup. None of those live inside your editor.

And if you're working with an AI assistant? Every CSV operation means another round-trip — "write me a script to filter this", "now save it back", "actually change that column name first". It's slow.

Chomper fixes both problems. **You** get a visual SQL IDE with filtering, editing, and sorting. **Your AI** gets an MCP server with direct SQL access to your files. Everyone chomps faster.

## Features

### Query 500K+ rows without breaking a sweat

Data loads in 10,000-row chunks with automatic pagination as you scroll. The status bar shows exactly where you are — no freezing, no waiting.

![Full query interface with schema explorer, SQL editor, and results table](https://raw.githubusercontent.com/Ryveal-io/sql-csv-tool/main/packages/extension/images/img_02_pane.png)

### Excel-style column filtering

Click the filter icon on any column header to get a rich filter panel:
- Value checkboxes with frequency bars and counts
- Search within the value list (Select All respects your search)
- Null statistics and distinct count
- Active filters appear as chips above the table — click to remove

![Filter panel showing value checkboxes with frequency counts](https://raw.githubusercontent.com/Ryveal-io/sql-csv-tool/main/packages/extension/images/img_03_column_filter_string.png)

### Date & time intelligence

Date columns get special treatment — histogram buckets by hour, day, week, month, or year. Click any bucket to instantly filter to that time range.

![Date column filter with temporal histogram buckets](https://raw.githubusercontent.com/Ryveal-io/sql-csv-tool/main/packages/extension/images/img_04_column_filter_time_field.png)

### Edit cells inline and save back

Double-click any cell to edit in place. Changes update the in-memory database instantly. Hit **Save** to write back to disk, or **Save As** to export with custom delimiters, quoting, and formatting.

![Inline cell editing with save and filter tokens](https://raw.githubusercontent.com/Ryveal-io/sql-csv-tool/main/packages/extension/images/img_05_edit_cells_and_save.png)

### SQL intellisense

Full autocomplete for table names, column names (auto-quoted when they contain spaces), SQL keywords, and 60+ DuckDB built-in functions.

![SQL autocomplete showing table and column suggestions](https://raw.githubusercontent.com/Ryveal-io/sql-csv-tool/main/packages/extension/images/img_06_sql_intellisense.png)

### Scroll through massive files

Virtual scrolling keeps things smooth even with hundreds of thousands of rows. Load more data automatically as you scroll, or run a query to narrow things down.

![Scrolling through a large filtered dataset](https://raw.githubusercontent.com/Ryveal-io/sql-csv-tool/main/packages/extension/images/img_07_fast_paginate.png)

### Column operations

Right-click any column header to rename, insert, or delete columns. Load multiple files and JOIN across them — the schema explorer shows every table with columns, types, unique counts, and null percentages.

### Find & Replace

Search and replace across any column with case-sensitive and regex support. Live match count shows how many values will change before you commit.

### Save As with options

Export your data exactly how you need it:
- **Delimiter**: comma, tab, pipe, semicolon, or custom
- **Quoting**: always, as needed, or never
- **Options**: include/exclude header, add row numbers
- **Format**: .csv, .tsv, .txt

## MCP Server — Let your AI chomp too

SQL CSV Chomper includes a bundled **MCP (Model Context Protocol) server** so AI assistants can work with your CSV files directly. No more "write me a Python script to filter column X" — just let them query.

### GitHub Copilot

The MCP server registers automatically in VS Code 1.99+. Copilot can load files, run queries, edit data, and push results into the visual editor.

### Claude Code

**Option 1 — From VS Code** (easiest):

1. `Cmd+Shift+P` (or `Ctrl+Shift+P`)
2. Search **"SQL CSV Chomper: Configure MCP for Claude CLI"**
3. Choose **User** (all projects) or **Project** (this workspace)
4. Done — Claude can now chomp your CSVs

**Option 2 — From the terminal**:

```bash
# Find the extension's MCP server path
CHOMPER_MCP="$(find ~/.vscode/extensions -path '*/sql-csv-chomper-*/out/mcp/server.js' | head -1)"

# Add for all projects
claude mcp add sql-csv-tool --scope user -- node "$CHOMPER_MCP"

# Or add for just the current project
claude mcp add sql-csv-tool --scope project -- node "$CHOMPER_MCP"
```

**Option 3 — Manual config** (add to `~/.claude/settings.json` or `.claude/settings.json` in your project):

```json
{
  "mcpServers": {
    "sql-csv-tool": {
      "type": "stdio",
      "command": "node",
      "args": ["~/.vscode/extensions/marksawczuk.sql-csv-chomper-0.2.0/out/mcp/server.js"]
    }
  }
}
```

> **Note:** The version number in the path (e.g. `0.2.0`) will change with updates. Use the `find` command above or the VS Code command palette to get the correct path.

### MCP tools available

| Tool | What it does |
|------|-------------|
| `load_csv` | Load a CSV/TSV file as a named table |
| `execute_sql` | Run any SQL query |
| `list_tables` | List all loaded tables |
| `list_columns` | Get column names and types |
| `get_schema` | Full schema for all tables |
| `update_rows` | Update rows matching a condition |
| `insert_row` | Insert a new row |
| `delete_rows` | Delete matching rows |
| `save_table` | Export a table to CSV |
| `set_editor_sql` | Push SQL into the editor |
| `run_editor_query` | Set and run SQL in the editor |

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Run query |
| `Shift+Alt+F` | Format SQL |
| `Ctrl+H` | Toggle Find & Replace |
| `Escape` | Close menus / cancel edit |
| `Right-click cell` | Context menu with filter options |
| `Right-click header` | Column operations |

## Supported files

| Extension | Format |
|-----------|--------|
| `.csv` | Comma-separated values |
| `.tsv` | Tab-separated values |
| `.tab` | Tab-delimited |
| `.txt` | Text (auto-detected delimiter) |
| `.jsonl` | JSON Lines |

## How it works

- **DuckDB WASM** runs entirely in your browser — zero external dependencies
- Files load into an in-memory DuckDB instance when opened
- SQL executes at native speed against the in-memory database
- Edits modify the in-memory table; **Save** writes back to disk
- The MCP server runs a separate DuckDB instance for AI workflows

## Requirements

- VS Code 1.85+
- Node.js (for the MCP server only)

## License

[MIT](LICENSE)
