# Changelog

## 0.4.0 - 2026-07-17

Delimited-file fidelity release. The headline fix: **files now keep their original format when you save them.**

### Fixed
- **Format-preserving save.** Opening a pipe-delimited, tab-delimited or otherwise non-comma file and saving it previously rewrote it as comma-delimited under the same name — silently corrupting the source. The file's delimiter, quoting, escape character and header are now detected on load (via DuckDB's `sniff_csv`) and reused on save. Fields containing the delimiter are re-quoted so they round-trip intact. This affects both the editor and the MCP server's `save_table`.
- **"Never quote" export** now actually emits unquoted values instead of silently falling back to the default.
- **Column stats no longer collide** for columns whose names differ only in punctuation (e.g. `a b` vs `a-b`).
- **Date-range filters** from the column filter panel no longer store an undefined selection.

### Added
- **Load Options dialog** (editor) and load overrides (MCP) — set the column delimiter, row delimiter, header, quote/escape characters, encoding, skip-rows, all-text and skip-malformed-rows when auto-detection gets it wrong, then re-read the file in place.
- **Resizable columns** — drag any column edge; double-click a handle to auto-fit.
- **Column profiling** — the schema explorer shows the longest value per column and, on hover, a full breakdown (distinct, null, whitespace-only, and numeric-looking value counts). New MCP `profile_table` tool with the same stats.
- **`profile_file`** (MCP) — scan a file *before* loading it: dialect, row/field counts, and columns whose length looks suspicious.
- **`diff_tables`** (MCP) — schema-aware diff of two tables on a key column, including blank-vs-populated counts.
- **Persistent table aliases** (MCP) — loaded tables are remembered across restarts (metadata only, never row data) and can be reloaded with their stored dialect via `list_remembered_tables` / `reload_remembered_tables`.
- **`unload_csv`** (MCP) — drop a table and forget its metadata.
- **`.psv`** (pipe-separated) files open in the editor; the open dialog also lists `.dat`.

### Notes
- **DuckDB reads an empty CSV field as `NULL`**, including a quoted empty field — the two are indistinguishable once loaded, because the format itself cannot tell them apart. Query empties with `IS NULL`, not `= ''`. `profile_table` reports whitespace-only counts separately, a distinction DuckDB *does* keep. Documented in the READMEs and the MCP tool guidance.

*(Covers changes accumulated since 0.1.0; the 0.2.x and 0.3.x point releases were not separately changelogged.)*

## 0.1.0 - 2026-03-03

Initial release.

### Features
- **Custom CSV Editor** for VS Code — opens `.csv`, `.tsv`, `.tab`, `.jsonl`, `.txt` files with a SQL IDE layout
- **DuckDB WASM** SQL engine running entirely in-browser
- **Monaco SQL editor** with autocomplete for tables, columns, keywords, and DuckDB functions
- **Virtual scrolling** with automatic chunked loading (10K row chunks) for large files (500K+ rows)
- **Inline cell editing** — double-click to edit, saves to DuckDB, local state update (no re-fetch)
- **Column filtering** — Excel-style filter panel with value checkboxes, search, null stats, numeric/date profiling
- **Column operations** — right-click headers to rename, insert, or delete columns
- **Find & Replace** — search and replace across columns with regex and case-sensitive options
- **Sort** — click column headers to sort; hover shows sort indicator
- **Save / Save As** — save back to original file or export with custom delimiter, quoting, row numbers, and file extension
- **SQL formatting** — Format button and Shift+Alt+F shortcut
- **Multi-table support** — load multiple files and query across them with JOINs
- **Schema explorer** — sidebar showing loaded tables, columns, types, and row counts
- **MCP server** — bundled MCP server for Claude CLI and GitHub Copilot integration
- **"Configure MCP for Claude CLI"** command in the Command Palette
