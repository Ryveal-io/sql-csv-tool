import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import type { QueryResult, QueryColumn } from '../types/query';
import { CellContextMenu, type SelectedCell } from './CellContextMenu';
import { ColumnFilterPanel } from './ColumnFilterPanel';

interface CellId {
  rowIndex: number;
  columnName: string;
}

interface ContextMenuState {
  x: number;
  y: number;
}

interface EditingCell {
  rowIndex: number;
  columnName: string;
  value: string;
}

interface HeaderMenuState {
  x: number;
  y: number;
  columnName: string;
}

interface FilterPanelState {
  columnName: string;
  columnType: string;
  rect: DOMRect;
}

interface ResultsTableProps {
  result: QueryResult | null;
  error: string | null;
  isLoading: boolean;
  columnTypes?: QueryColumn[];
  onFilter?: (filterClause: string) => void;
  editable?: boolean;
  onCellEdit?: (rowid: number, columnName: string, newValue: string) => void;
  activeTable?: string | null;
  columnFilters?: Map<string, string>;
  onApplyColumnFilter?: (columnName: string, clause: string) => void;
  onClearColumnFilter?: (columnName: string) => void;
  onRenameColumn?: (oldName: string, newName: string) => void;
  onInsertColumn?: (afterColumn: string, position: 'left' | 'right') => void;
  onDeleteColumn?: (columnName: string) => void;
}

function cellKey(rowIndex: number, columnName: string): string {
  return `${rowIndex}:${columnName}`;
}

const ROW_HEIGHT = 24;

export function ResultsTable({
  result,
  error,
  isLoading,
  columnTypes,
  onFilter,
  editable,
  onCellEdit,
  activeTable,
  columnFilters,
  onApplyColumnFilter,
  onClearColumnFilter,
  onRenameColumn,
  onInsertColumn,
  onDeleteColumn,
}: ResultsTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selectedCells, setSelectedCells] = useState<Map<string, CellId>>(new Map());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [headerMenu, setHeaderMenu] = useState<HeaderMenuState | null>(null);
  const [filterPanel, setFilterPanel] = useState<FilterPanelState | null>(null);

  const tableContainerRef = useRef<HTMLDivElement>(null);

  // Build a map of column name → type for quick lookup
  const typeMap = useMemo(() => {
    const map = new Map<string, string>();
    if (columnTypes) {
      for (const col of columnTypes) {
        map.set(col.name, col.type);
      }
    }
    if (result) {
      for (const col of result.columns) {
        if (!map.has(col.name)) map.set(col.name, col.type);
      }
    }
    return map;
  }, [columnTypes, result?.columns]);

  // Filter out rowid column from display
  const displayColumns = useMemo(() => {
    if (!result) return [];
    return result.columns.filter(col => col.name !== 'rowid');
  }, [result?.columns]);

  const handleCellClick = useCallback(
    (e: React.MouseEvent, rowIndex: number, columnName: string) => {
      const key = cellKey(rowIndex, columnName);
      if (e.metaKey || e.ctrlKey) {
        setSelectedCells((prev) => {
          const next = new Map(prev);
          if (next.has(key)) next.delete(key);
          else next.set(key, { rowIndex, columnName });
          return next;
        });
      } else {
        setSelectedCells(new Map([[key, { rowIndex, columnName }]]));
      }
      setContextMenu(null);
    },
    []
  );

  const handleCellDoubleClick = useCallback(
    (rowIndex: number, columnName: string, currentValue: unknown) => {
      if (!editable || !onCellEdit) return;
      setEditingCell({
        rowIndex,
        columnName,
        value: currentValue === null || currentValue === undefined ? '' : String(currentValue),
      });
    },
    [editable, onCellEdit]
  );

  const commitEdit = useCallback(() => {
    if (!editingCell || !onCellEdit || !result) return;
    const row = result.rows[editingCell.rowIndex];
    const rowid = row?.rowid;
    if (rowid === undefined || rowid === null) return;
    onCellEdit(Number(rowid), editingCell.columnName, editingCell.value);
    setEditingCell(null);
  }, [editingCell, onCellEdit, result]);

  const cancelEdit = useCallback(() => {
    setEditingCell(null);
  }, []);

  const handleCellContextMenu = useCallback(
    (e: React.MouseEvent, rowIndex: number, columnName: string) => {
      e.preventDefault();
      const key = cellKey(rowIndex, columnName);
      setSelectedCells((prev) => {
        if (prev.has(key)) return prev;
        return new Map([[key, { rowIndex, columnName }]]);
      });
      setContextMenu({ x: e.clientX, y: e.clientY });
    },
    []
  );

  // Header right-click for column operations
  const handleHeaderContextMenu = useCallback((e: React.MouseEvent, colName: string) => {
    e.preventDefault();
    e.stopPropagation();
    setHeaderMenu({ x: e.clientX, y: e.clientY, columnName: colName });
  }, []);

  // Filter icon click
  const handleFilterClick = useCallback((e: React.MouseEvent, colName: string, colType: string) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setFilterPanel({ columnName: colName, columnType: colType, rect });
  }, []);

  const selectedCellData = useMemo((): SelectedCell[] => {
    if (!result) return [];
    return Array.from(selectedCells.values()).map(({ rowIndex, columnName }) => {
      const row = result.rows[rowIndex];
      return {
        columnName,
        columnType: typeMap.get(columnName) ?? 'VARCHAR',
        value: row ? row[columnName] : null,
      };
    });
  }, [selectedCells, result, typeMap]);

  const handleFilter = useCallback(
    (clause: string) => {
      onFilter?.(clause);
      setContextMenu(null);
      setSelectedCells(new Map());
    },
    [onFilter]
  );

  const columns = useMemo<ColumnDef<Record<string, unknown>>[]>(() => {
    if (!result) return [];
    return displayColumns.map((col) => ({
      accessorKey: col.name,
      header: () => <span title={col.type}>{col.name}</span>,
      cell: (info) => {
        const val = info.getValue();
        if (val === null || val === undefined) return <span className="null-value">NULL</span>;
        return String(val);
      },
    }));
  }, [displayColumns]);

  const table = useReactTable({
    data: result?.rows ?? [],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const { rows } = table.getRowModel();

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Clear selection when results change
  const resultId = result?.rowCount;
  useMemo(() => {
    setSelectedCells(new Map());
    setContextMenu(null);
    setEditingCell(null);
  }, [resultId]);

  if (isLoading) {
    return <div className="results-message">Loading...</div>;
  }

  if (error) {
    return <div className="results-error">{error}</div>;
  }

  if (!result) {
    return <div className="results-message">Run a query to see results</div>;
  }

  return (
    <div className="results-container">
      <div className="virtual-table-container" ref={tableContainerRef}>
        <table>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                <th className="row-number-header">#</th>
                {headerGroup.headers.map((header) => {
                  const colName = header.column.id;
                  const colType = typeMap.get(colName) ?? '';
                  const hasFilter = columnFilters?.has(colName);
                  return (
                    <th
                      key={header.id}
                      className={header.column.getIsSorted() ? 'sorted' : ''}
                      onContextMenu={(e) => handleHeaderContextMenu(e, colName)}
                    >
                      <div className="th-content" onClick={header.column.getToggleSortingHandler()}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {{ asc: ' \u25B2', desc: ' \u25BC' }[header.column.getIsSorted() as string] ?? ''}
                      </div>
                      {activeTable && (
                        <span
                          className={`col-filter-icon${hasFilter ? ' col-filter-icon-active' : ''}`}
                          onClick={(e) => handleFilterClick(e, colName, colType)}
                          title="Filter"
                        >{'\u25BE'}</span>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative', display: 'block' }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              const originalIndex = result.rows.indexOf(row.original);
              return (
                <tr
                  key={row.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                    display: 'table-row',
                  }}
                >
                  <td className="row-number">{virtualRow.index + 1}</td>
                  {row.getVisibleCells().map((cell) => {
                    const colName = cell.column.id;
                    const isSelected = selectedCells.has(cellKey(originalIndex, colName));
                    const isEditing = editingCell?.rowIndex === originalIndex && editingCell?.columnName === colName;

                    if (isEditing) {
                      return (
                        <td key={cell.id} className="cell-editing">
                          <input
                            autoFocus
                            value={editingCell.value}
                            onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitEdit();
                              if (e.key === 'Escape') cancelEdit();
                            }}
                            onBlur={commitEdit}
                          />
                        </td>
                      );
                    }

                    return (
                      <td
                        key={cell.id}
                        className={isSelected ? 'cell-selected' : ''}
                        onClick={(e) => handleCellClick(e, originalIndex, colName)}
                        onDoubleClick={() => handleCellDoubleClick(originalIndex, colName, row.original[colName])}
                        onContextMenu={(e) => handleCellContextMenu(e, originalIndex, colName)}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {contextMenu && selectedCellData.length > 0 && (
        <CellContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          selectedCells={selectedCellData}
          onFilter={handleFilter}
          onClose={() => setContextMenu(null)}
        />
      )}

      {headerMenu && (
        <ColumnHeaderMenu
          x={headerMenu.x}
          y={headerMenu.y}
          columnName={headerMenu.columnName}
          onRename={onRenameColumn}
          onInsertLeft={onInsertColumn ? () => { onInsertColumn(headerMenu.columnName, 'left'); setHeaderMenu(null); } : undefined}
          onInsertRight={onInsertColumn ? () => { onInsertColumn(headerMenu.columnName, 'right'); setHeaderMenu(null); } : undefined}
          onDelete={onDeleteColumn}
          onClose={() => setHeaderMenu(null)}
        />
      )}

      {filterPanel && activeTable && (
        <ColumnFilterPanel
          tableName={activeTable}
          columnName={filterPanel.columnName}
          columnType={filterPanel.columnType}
          anchorRect={filterPanel.rect}
          onApplyFilter={(colName, clause) => {
            onApplyColumnFilter?.(colName, clause);
            setFilterPanel(null);
          }}
          onClearFilter={(colName) => {
            onClearColumnFilter?.(colName);
            setFilterPanel(null);
          }}
          onClose={() => setFilterPanel(null)}
        />
      )}
    </div>
  );
}

function ColumnHeaderMenu({
  x,
  y,
  columnName,
  onRename,
  onInsertLeft,
  onInsertRight,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  columnName: string;
  onRename?: (oldName: string, newName: string) => void;
  onInsertLeft?: () => void;
  onInsertRight?: () => void;
  onDelete?: (columnName: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', handleKey);
    setTimeout(() => document.addEventListener('mousedown', handleClick), 0);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onClose]);

  return (
    <div ref={menuRef} className="context-menu" style={{ top: y, left: x }}>
      <div className="context-menu-header">{columnName}</div>
      {onRename && (
        <div className="context-menu-item" onClick={() => {
          const newName = window.prompt(`Rename "${columnName}" to:`, columnName);
          if (newName && newName !== columnName) onRename(columnName, newName);
          onClose();
        }}>Rename Column...</div>
      )}
      {onInsertLeft && (
        <div className="context-menu-item" onClick={onInsertLeft}>Insert Column Left</div>
      )}
      {onInsertRight && (
        <div className="context-menu-item" onClick={onInsertRight}>Insert Column Right</div>
      )}
      {onDelete && (
        <>
          <div className="context-menu-separator" />
          <div className="context-menu-item" style={{ color: 'var(--vscode-errorForeground)' }} onClick={() => {
            if (window.confirm(`Delete column "${columnName}"?`)) onDelete(columnName);
            onClose();
          }}>Delete Column</div>
        </>
      )}
    </div>
  );
}
