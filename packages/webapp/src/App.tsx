import { useState, useCallback, useMemo } from 'react';
import { Layout } from './components/Layout';
import { SqlEditor } from './components/SqlEditor';
import { ResultsTable } from './components/ResultsTable';
import { Toolbar } from './components/Toolbar';
import { StatusBar } from './components/StatusBar';
import { SchemaExplorer } from './components/SchemaExplorer';
import { useDuckDb } from './hooks/useDuckDb';
import { useQueryExecution } from './hooks/useQueryExecution';
import { useVsCodeMessaging } from './hooks/useVsCodeMessaging';
import { exportCsv, describeTable, dropTable, updateCell, saveTableToBytes } from './services/duckdb';
import { clearProfileCache } from './components/ColumnProfilePopover';
import { postMessageToExtension } from './services/vscodeMessenger';
import { pickFile } from './services/standaloneAdapter';
import type { TableInfo } from './types/query';

function defaultQueryForTable(tableName: string): string {
  return `SELECT rowid, * FROM "${tableName}" LIMIT 1000`;
}

function isEditableDefaultQuery(sql: string, activeTable: string | null): boolean {
  if (!activeTable) return false;
  const pattern = new RegExp(
    `^\\s*SELECT\\s+rowid\\s*,\\s*\\*\\s+FROM\\s+"?${activeTable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s*(WHERE\\s+.+)?\\s*(LIMIT\\s+\\d+)?\\s*;?\\s*$`,
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

export default function App() {
  const [sql, setSql] = useState('');
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [dirtyTables, setDirtyTables] = useState<Set<string>>(new Set());

  const { isReady, isLoading: dbLoading, error: dbError, loadFile } = useDuckDb();
  const { result, error: queryError, isExecuting, runQuery } = useQueryExecution();

  const handleLoad = useCallback(async (name: string, content: Uint8Array) => {
    const tableName = await loadFile(name, content);
    const columns = await describeTable(tableName);
    setTables(prev => {
      const existing = prev.findIndex(t => t.name === tableName);
      const entry: TableInfo = { name: tableName, fileName: name, columns };
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = entry;
        return next;
      }
      return [...prev, entry];
    });
    setActiveTable(tableName);
    const query = defaultQueryForTable(tableName);
    setSql(query);
    runQuery(query);
  }, [loadFile, runQuery]);

  const handleSelectTable = useCallback((tableName: string) => {
    setActiveTable(tableName);
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
  }, []);

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

  const handleCellEdit = useCallback(async (rowid: number, columnName: string, newValue: string) => {
    if (!activeTable) return;
    const colInfo = tables.find(t => t.name === activeTable)?.columns.find(c => c.name === columnName);
    const colType = colInfo?.type ?? 'VARCHAR';
    await updateCell(activeTable, rowid, columnName, newValue || null, colType);
    setDirtyTables(prev => new Set(prev).add(activeTable));
    clearProfileCache(activeTable);
    // Re-run current query to refresh results
    runQuery(sql);
  }, [activeTable, tables, sql, runQuery]);

  const handleSave = useCallback(async () => {
    if (!activeTable) return;
    const bytes = await saveTableToBytes(activeTable);
    const fileName = tables.find(t => t.name === activeTable)?.fileName ?? `${activeTable}.csv`;

    if (isVsCode) {
      postMessageToExtension({ type: 'saveTable', fileName, content: Array.from(bytes) });
    } else {
      // Standalone: trigger browser download
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

  const error = dbError || queryError;
  const activeFileName = tables.find(t => t.name === activeTable)?.fileName ?? '';
  const isDirty = activeTable ? dirtyTables.has(activeTable) : false;

  return (
    <Layout
      toolbar={
        <Toolbar
          onRun={handleRun}
          isLoading={dbLoading || isExecuting}
          fileName={activeFileName}
          isDirty={isDirty}
          onSave={handleSave}
        />
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
        />
      }
      statusBar={
        <StatusBar result={result} />
      }
    />
  );
}
