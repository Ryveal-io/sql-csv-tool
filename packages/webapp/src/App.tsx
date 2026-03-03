import { useState, useCallback, useMemo } from 'react';
import { Layout } from './components/Layout';
import { SqlEditor } from './components/SqlEditor';
import { ResultsTable } from './components/ResultsTable';
import { Toolbar } from './components/Toolbar';
import { StatusBar } from './components/StatusBar';
import { SchemaExplorer } from './components/SchemaExplorer';
import { FindReplaceBar } from './components/FindReplaceBar';
import { SaveAsDialog, type SaveAsOptions } from './components/SaveAsDialog';
import { useDuckDb } from './hooks/useDuckDb';
import { useQueryExecution } from './hooks/useQueryExecution';
import { useVsCodeMessaging } from './hooks/useVsCodeMessaging';
import {
  exportCsv,
  describeTable,
  dropTable,
  updateCell,
  saveTableToBytes,
  saveTableWithOptions,
  getTableRowCount,
  renameColumn,
  addColumn,
  dropColumn,
  reorderColumns,
  findReplaceInColumn,
} from './services/duckdb';
import { clearProfileCache } from './components/ColumnFilterPanel';
import { postMessageToExtension } from './services/vscodeMessenger';
import { pickFile } from './services/standaloneAdapter';
import type { TableInfo } from './types/query';

function defaultQueryForTable(tableName: string): string {
  return `SELECT rowid, * FROM "${tableName}"`;
}

function isEditableDefaultQuery(sql: string, activeTable: string | null): boolean {
  if (!activeTable) return false;
  const pattern = new RegExp(
    `^\\s*SELECT\\s+rowid\\s*,\\s*\\*\\s+FROM\\s+"?${activeTable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s*(WHERE\\s+.+)?\\s*;?\\s*$`,
    'i'
  );
  return pattern.test(sql.trim());
}

function insertWhereClause(sql: string, clause: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, '');

  const whereMatch = trimmed.match(/\bWHERE\b/i);
  if (whereMatch) {
    const afterWhere = trimmed.slice(whereMatch.index! + whereMatch[0].length);
    const endPattern = /\b(GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|UNION|EXCEPT|INTERSECT)\b/i;
    const endMatch = afterWhere.match(endPattern);

    if (endMatch) {
      const insertPos = whereMatch.index! + whereMatch[0].length + endMatch.index!;
      return trimmed.slice(0, insertPos).trimEnd() + ' AND ' + clause + ' ' + trimmed.slice(insertPos);
    }
    return trimmed + ' AND ' + clause;
  }

  const insertPattern = /\b(GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|UNION|EXCEPT|INTERSECT)\b/i;
  const insertMatch = trimmed.match(insertPattern);

  if (insertMatch) {
    const pos = insertMatch.index!;
    return trimmed.slice(0, pos).trimEnd() + ' WHERE ' + clause + ' ' + trimmed.slice(pos);
  }

  return trimmed + ' WHERE ' + clause;
}

/** Build a full SQL query from the base default query plus all active column filters. */
function buildFilteredQuery(tableName: string, columnFilters: Map<string, string>): string {
  let sql = defaultQueryForTable(tableName);
  for (const clause of columnFilters.values()) {
    sql = insertWhereClause(sql, clause);
  }
  return sql;
}

export default function App() {
  const [sql, setSql] = useState('');
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [dirtyTables, setDirtyTables] = useState<Set<string>>(new Set());
  const [columnFilters, setColumnFilters] = useState<Map<string, string>>(new Map());
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [showSaveAs, setShowSaveAs] = useState(false);

  const { isReady, isLoading: dbLoading, error: dbError, loadFile } = useDuckDb();
  const { result, totalQueryRows, hasMore, error: queryError, isExecuting, isFetchingMore, runQuery, fetchMore, updateRow } = useQueryExecution();

  const handleLoad = useCallback(async (name: string, content: Uint8Array) => {
    const tableName = await loadFile(name, content);
    const columns = await describeTable(tableName);
    const rowCount = await getTableRowCount(tableName);
    setTables(prev => {
      const existing = prev.findIndex(t => t.name === tableName);
      const entry: TableInfo = { name: tableName, fileName: name, columns, rowCount };
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = entry;
        return next;
      }
      return [...prev, entry];
    });
    setActiveTable(tableName);
    setColumnFilters(new Map());
    const query = defaultQueryForTable(tableName);
    setSql(query);
    runQuery(query);
  }, [loadFile, runQuery]);

  const handleSelectTable = useCallback((tableName: string) => {
    setActiveTable(tableName);
    setColumnFilters(new Map());
    const query = defaultQueryForTable(tableName);
    setSql(query);
    runQuery(query);
  }, [runQuery]);

  const handleRemoveTable = useCallback(async (tableName: string) => {
    await dropTable(tableName);
    setTables(prev => prev.filter(t => t.name !== tableName));
    setDirtyTables(prev => {
      const next = new Set(prev);
      next.delete(tableName);
      return next;
    });
    setActiveTable(prev => {
      if (prev === tableName) return null;
      return prev;
    });
    if (activeTable === tableName) setColumnFilters(new Map());
  }, [activeTable]);

  const handleExport = useCallback(async () => {
    const csvData = await exportCsv(activeTable ?? undefined);
    postMessageToExtension({ type: 'csvData', content: Array.from(csvData) });
  }, [activeTable]);

  const handleSetSql = useCallback((newSql: string) => {
    setSql(newSql);
  }, []);

  const handleRunQuery = useCallback((newSql: string) => {
    setSql(newSql);
    runQuery(newSql);
  }, [runQuery]);

  const { isVsCode } = useVsCodeMessaging({
    onLoad: handleLoad,
    onRequestExport: handleExport,
    onSetSql: handleSetSql,
    onRunQuery: handleRunQuery,
  });

  const handleRun = useCallback(() => {
    runQuery(sql);
  }, [sql, runQuery]);

  const handleFilter = useCallback((clause: string) => {
    setSql((prev) => {
      const newSql = insertWhereClause(prev, clause);
      setTimeout(() => runQuery(newSql), 0);
      return newSql;
    });
  }, [runQuery]);

  const handleOpenFile = useCallback(async () => {
    try {
      const { name, content } = await pickFile();
      await handleLoad(name, content);
    } catch {
      // User cancelled file picker
    }
  }, [handleLoad]);

  const editable = isEditableDefaultQuery(sql, activeTable);

  const handleCellEdit = useCallback(async (rowIndex: number, rowid: number, columnName: string, newValue: string) => {
    if (!activeTable) return;
    const colInfo = tables.find(t => t.name === activeTable)?.columns.find(c => c.name === columnName);
    const colType = colInfo?.type ?? 'VARCHAR';
    await updateCell(activeTable, rowid, columnName, newValue || null, colType);
    setDirtyTables(prev => new Set(prev).add(activeTable));
    clearProfileCache(activeTable);
    // Update local state instead of re-fetching all rows
    const coerced = newValue === '' ? null : newValue;
    updateRow(rowIndex, columnName, coerced);
  }, [activeTable, tables, updateRow]);

  const handleSave = useCallback(async () => {
    if (!activeTable) return;
    const bytes = await saveTableToBytes(activeTable);
    const fileName = tables.find(t => t.name === activeTable)?.fileName ?? `${activeTable}.csv`;

    if (isVsCode) {
      postMessageToExtension({ type: 'saveTable', fileName, content: Array.from(bytes) });
    } else {
      const blob = new Blob([bytes], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    }
    setDirtyTables(prev => {
      const next = new Set(prev);
      next.delete(activeTable);
      return next;
    });
  }, [activeTable, tables, isVsCode]);

  const handleSaveAs = useCallback(async (options: SaveAsOptions) => {
    if (!activeTable) return;
    const bytes = await saveTableWithOptions(activeTable, options);
    const baseName = tables.find(t => t.name === activeTable)?.fileName?.replace(/\.[^.]+$/, '') ?? activeTable;
    const fileName = `${baseName}${options.fileExtension}`;

    if (isVsCode) {
      postMessageToExtension({ type: 'saveTableAs', fileName, fileExtension: options.fileExtension, content: Array.from(bytes) });
    } else {
      const blob = new Blob([bytes], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    }
    setShowSaveAs(false);
  }, [activeTable, tables, isVsCode]);

  // Column filter handlers
  const handleApplyColumnFilter = useCallback((columnName: string, clause: string) => {
    if (!activeTable) return;
    setColumnFilters(prev => {
      const next = new Map(prev);
      next.set(columnName, clause);
      const newSql = buildFilteredQuery(activeTable, next);
      setSql(newSql);
      setTimeout(() => runQuery(newSql), 0);
      return next;
    });
  }, [activeTable, runQuery]);

  const handleClearColumnFilter = useCallback((columnName: string) => {
    if (!activeTable) return;
    setColumnFilters(prev => {
      const next = new Map(prev);
      next.delete(columnName);
      const newSql = buildFilteredQuery(activeTable, next);
      setSql(newSql);
      setTimeout(() => runQuery(newSql), 0);
      return next;
    });
  }, [activeTable, runQuery]);

  // Column operations
  const refreshTableSchema = useCallback(async (tableName: string) => {
    const columns = await describeTable(tableName);
    const rowCount = await getTableRowCount(tableName);
    setTables(prev => prev.map(t => t.name === tableName ? { ...t, columns, rowCount } : t));
  }, []);

  const handleRenameColumn = useCallback(async (oldName: string, newName: string) => {
    if (!activeTable) return;
    await renameColumn(activeTable, oldName, newName);
    setDirtyTables(prev => new Set(prev).add(activeTable));
    clearProfileCache(activeTable);
    await refreshTableSchema(activeTable);
    // Update column filters if the renamed column had a filter
    setColumnFilters(prev => {
      if (!prev.has(oldName)) return prev;
      const next = new Map(prev);
      const clause = next.get(oldName)!;
      next.delete(oldName);
      next.set(newName, clause);
      return next;
    });
    const query = defaultQueryForTable(activeTable);
    setSql(query);
    runQuery(query);
  }, [activeTable, runQuery, refreshTableSchema]);

  const handleInsertColumn = useCallback(async (refColumn: string, position: 'left' | 'right') => {
    if (!activeTable) return;
    const newName = window.prompt('New column name:', 'new_column');
    if (!newName) return;
    await addColumn(activeTable, newName);
    // Reorder to place the new column at the correct position
    const currentCols = (await describeTable(activeTable)).map(c => c.name);
    const refIdx = currentCols.indexOf(refColumn);
    const newIdx = currentCols.indexOf(newName);
    if (refIdx >= 0 && newIdx >= 0) {
      const ordered = currentCols.filter(c => c !== newName);
      const insertAt = position === 'left' ? refIdx : refIdx + 1;
      ordered.splice(insertAt, 0, newName);
      await reorderColumns(activeTable, ordered);
    }
    setDirtyTables(prev => new Set(prev).add(activeTable));
    clearProfileCache(activeTable);
    await refreshTableSchema(activeTable);
    const query = defaultQueryForTable(activeTable);
    setSql(query);
    runQuery(query);
  }, [activeTable, runQuery, refreshTableSchema]);

  const handleDeleteColumn = useCallback(async (columnName: string) => {
    if (!activeTable) return;
    await dropColumn(activeTable, columnName);
    setDirtyTables(prev => new Set(prev).add(activeTable));
    clearProfileCache(activeTable);
    setColumnFilters(prev => {
      const next = new Map(prev);
      next.delete(columnName);
      return next;
    });
    await refreshTableSchema(activeTable);
    const query = defaultQueryForTable(activeTable);
    setSql(query);
    runQuery(query);
  }, [activeTable, runQuery, refreshTableSchema]);

  // Find & replace
  const handleReplace = useCallback(async (
    tableName: string,
    columnName: string | null,
    find: string,
    replace: string,
    options: { caseSensitive: boolean; regex: boolean }
  ) => {
    if (!columnName) return;
    await findReplaceInColumn(tableName, columnName, find, replace, options);
    setDirtyTables(prev => new Set(prev).add(tableName));
    clearProfileCache(tableName);
    const rowCount = await getTableRowCount(tableName);
    setTables(prev => prev.map(t => t.name === tableName ? { ...t, rowCount } : t));
    runQuery(sql);
  }, [sql, runQuery]);

  // Build table schemas map for intellisense
  const tableSchemas = useMemo(() => {
    const schemas: Record<string, import('./types/query').QueryColumn[]> = {};
    for (const t of tables) {
      schemas[t.name] = t.columns;
    }
    return schemas;
  }, [tables]);

  // Get active table's columns for result type hints
  const activeColumns = useMemo(() => {
    return tables.find(t => t.name === activeTable)?.columns ?? [];
  }, [tables, activeTable]);

  const totalRows = tables.find(t => t.name === activeTable)?.rowCount;
  const error = dbError || queryError;
  const activeFileName = tables.find(t => t.name === activeTable)?.fileName ?? '';
  const isDirty = activeTable ? dirtyTables.has(activeTable) : false;

  return (<>
    <Layout
      toolbar={
        <Toolbar
          onRun={handleRun}
          isLoading={dbLoading || isExecuting}
          fileName={activeFileName}
          isDirty={isDirty}
          onSave={handleSave}
          onSaveAs={() => setShowSaveAs(true)}
          onToggleFindReplace={() => setShowFindReplace(prev => !prev)}
          showFindReplace={showFindReplace}
          hasActiveTable={!!activeTable}
        />
      }
      findReplaceBar={
        showFindReplace ? (
          <FindReplaceBar
            tables={tables}
            activeTable={activeTable}
            onReplace={handleReplace}
            onClose={() => setShowFindReplace(false)}
          />
        ) : undefined
      }
      sqlEditor={
        <SqlEditor value={sql} onChange={setSql} onRun={handleRun} tableSchemas={tableSchemas} />
      }
      schemaPanel={
        <SchemaExplorer
          tables={tables}
          activeTable={activeTable}
          onSelectTable={handleSelectTable}
          onOpenFile={!isVsCode ? handleOpenFile : undefined}
          onRemoveTable={handleRemoveTable}
        />
      }
      resultsTable={
        <ResultsTable
          result={result}
          error={error}
          isLoading={dbLoading && !isReady}
          columnTypes={activeColumns}
          onFilter={handleFilter}
          editable={editable}
          onCellEdit={handleCellEdit}
          activeTable={activeTable}
          columnFilters={columnFilters}
          onApplyColumnFilter={handleApplyColumnFilter}
          onClearColumnFilter={handleClearColumnFilter}
          onRenameColumn={handleRenameColumn}
          onInsertColumn={handleInsertColumn}
          onDeleteColumn={handleDeleteColumn}
          hasMore={hasMore}
          isFetchingMore={isFetchingMore}
          onFetchMore={fetchMore}
        />
      }
      statusBar={
        <StatusBar result={result} totalRows={totalRows} totalQueryRows={totalQueryRows} />
      }
    />
    {showSaveAs && (
      <SaveAsDialog
        onSave={handleSaveAs}
        onClose={() => setShowSaveAs(false)}
      />
    )}
  </>
  );
}
