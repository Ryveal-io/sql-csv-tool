import { useState, useEffect, useRef } from 'react';
import type { QueryColumn, TableInfo } from '../types/query';
import { getColumnQuickStats, type ColumnQuickStats } from '../services/duckdb';

/**
 * The full stat breakdown, shown on hover because the panel is too narrow to
 * column it all. Lines that carry no signal for a given column are omitted
 * rather than shown as zero.
 */
function describeColumnStats(col: QueryColumn, s: ColumnQuickStats): string {
  const lines = [`${col.name} (${col.type})`, `${s.totalRows.toLocaleString()} rows`];

  lines.push(`${s.distinctCount.toLocaleString()} distinct`);
  lines.push(`${s.nullCount.toLocaleString()} null`);

  // DuckDB reads an empty CSV field as NULL, so this is normally 0 and only
  // becomes interesting for edited or non-CSV data — hence only shown when set.
  if (s.emptyCount > 0) lines.push(`${s.emptyCount.toLocaleString()} empty string ('')`);
  if (s.whitespaceCount > 0) lines.push(`${s.whitespaceCount.toLocaleString()} whitespace-only`);

  if (s.maxLength !== null) {
    lines.push(`length ${s.minLength ?? 0}–${s.maxLength}`);
  }

  // Numeric-looking data in a text column usually means it landed in the wrong
  // field upstream, so it's worth calling out — but only when it's not universal.
  if (s.numericCastableCount !== null) {
    const nonNull = s.totalRows - s.nullCount;
    if (s.numericCastableCount > 0 && nonNull > 0) {
      lines.push(
        s.numericCastableCount === nonNull
          ? 'all values are numeric'
          : `${s.numericCastableCount.toLocaleString()} of ${nonNull.toLocaleString()} values are numeric`
      );
    }
  }

  return lines.join('\n');
}

interface SchemaExplorerProps {
  tables: TableInfo[];
  activeTable: string | null;
  onSelectTable: (tableName: string) => void;
  onOpenFile?: () => void;
  onRemoveTable?: (tableName: string) => void;
}

export function SchemaExplorer({ tables, activeTable, onSelectTable, onOpenFile, onRemoveTable }: SchemaExplorerProps) {
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [columnStats, setColumnStats] = useState<Map<string, Map<string, ColumnQuickStats>>>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());

  // Auto-expand the active table
  useEffect(() => {
    if (activeTable) {
      setExpandedTables(prev => {
        if (prev.has(activeTable)) return prev;
        const next = new Set(prev);
        next.add(activeTable);
        return next;
      });
    }
  }, [activeTable]);

  const toggleExpanded = (tableName: string) => {
    setExpandedTables(prev => {
      const next = new Set(prev);
      if (next.has(tableName)) {
        next.delete(tableName);
      } else {
        next.add(tableName);
      }
      return next;
    });
  };

  // Load column stats when a table is expanded
  useEffect(() => {
    for (const tableName of expandedTables) {
      if (columnStats.has(tableName) || loadingRef.current.has(tableName)) continue;
      const table = tables.find(t => t.name === tableName);
      if (!table || table.columns.length === 0) continue;
      loadingRef.current.add(tableName);
      getColumnQuickStats(tableName, table.columns)
        .then(stats => {
          setColumnStats(prev => new Map(prev).set(tableName, stats));
        })
        .catch(() => { /* ignore */ })
        .finally(() => { loadingRef.current.delete(tableName); });
    }
  }, [expandedTables, tables, columnStats]);

  return (
    <div className="schema-panel">
      <div className="schema-header">
        <span>Schema</span>
        {onOpenFile && (
          <button className="schema-open-btn-styled" onClick={onOpenFile} title="Open CSV / TSV file">
            + Open
          </button>
        )}
      </div>
      {tables.length === 0 ? (
        <div className="schema-empty">
          {onOpenFile ? (
            <>
              <div>No tables loaded</div>
              <button className="schema-open-btn-hero" onClick={onOpenFile}>
                + Open a CSV file
              </button>
            </>
          ) : (
            'No table loaded'
          )}
        </div>
      ) : (
        <div className="schema-tree">
          {tables.map(table => {
            const isExpanded = expandedTables.has(table.name);
            const isActive = table.name === activeTable;
            const tableStats = columnStats.get(table.name);
            return (
              <div key={table.name} className="schema-table-entry">
                <div
                  className={`schema-table-row${isActive ? ' schema-table-active' : ''}`}
                  onClick={() => onSelectTable(table.name)}
                >
                  <span
                    className="schema-toggle"
                    onClick={(e) => { e.stopPropagation(); toggleExpanded(table.name); }}
                  >
                    {isExpanded ? '\u25BC' : '\u25B6'}
                  </span>
                  <span className="schema-table-label">{table.name}</span>
                  {table.fileName !== table.name && (
                    <span className="schema-table-file" title={table.fileName}>
                      {table.fileName}
                    </span>
                  )}
                  {onRemoveTable && (
                    <span
                      className="schema-table-close"
                      title={`Remove ${table.name}`}
                      onClick={(e) => { e.stopPropagation(); onRemoveTable(table.name); }}
                    >
                      &times;
                    </span>
                  )}
                </div>
                {isExpanded && (
                  <>
                    <div className="schema-col-header">
                      <span className="schema-col-h-name">Column</span>
                      <span className="schema-col-h-type">Type</span>
                      <span className="schema-col-h-unique">Unique</span>
                      <span className="schema-col-h-null">% Null</span>
                      <span className="schema-col-h-len" title="Longest value in this column">Len</span>
                    </div>
                    <ul className="schema-columns">
                      {table.columns.map(col => {
                        const stats = tableStats?.get(col.name);
                        const nullPct = stats && stats.totalRows > 0
                          ? (stats.nullCount / stats.totalRows) * 100
                          : 0;
                        return (
                          <li
                            key={col.name}
                            className="schema-column"
                            title={stats ? describeColumnStats(col, stats) : col.name}
                          >
                            <span className="schema-col-name">{col.name}</span>
                            <span className="schema-col-type">{col.type}</span>
                            <span className="schema-col-unique">
                              {stats ? stats.distinctCount.toLocaleString() : ''}
                            </span>
                            <span className="schema-col-null">
                              {stats ? (nullPct > 0 ? nullPct.toFixed(1) : '0') : ''}
                            </span>
                            <span className="schema-col-len">
                              {stats?.maxLength ?? ''}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>
            );
          })}
          {onOpenFile && (
            <button className="schema-open-btn-inline" onClick={onOpenFile} title="Open CSV / TSV file">
              + Open File
            </button>
          )}
        </div>
      )}
    </div>
  );
}
