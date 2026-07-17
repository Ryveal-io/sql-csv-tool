import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type ColumnSizingState,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import type { QueryResult, QueryColumn } from '../types/query';
import { CellContextMenu, type SelectedCell } from './CellContextMenu';
import { ColumnFilterPanel, type FilterSelection } from './ColumnFilterPanel';

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
  onCellEdit?: (rowIndex: number, rowid: number, columnName: string, newValue: string) => void;
  activeTable?: string | null;
  columnFilters?: Map<string, string>;
  columnFilterSelections?: Map<string, FilterSelection>;
  onApplyColumnFilter?: (columnName: string, clause: string, selection: FilterSelection) => void;
  onClearColumnFilter?: (columnName: string) => void;
  onRenameColumn?: (oldName: string, newName: string) => void;
  onInsertColumn?: (afterColumn: string, position: 'left' | 'right') => void;
  onDeleteColumn?: (columnName: string) => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
  onFetchMore?: () => void;
}

function cellKey(rowIndex: number, columnName: string): string {
  return `${rowIndex}:${columnName}`;
}

const ROW_HEIGHT = 28;

// Column sizing. The row-number column is not a TanStack column, so its width is
// fixed here and mirrored in globals.css (.row-number-header / .row-number).
const ROW_NUMBER_WIDTH = 48;
const COLUMN_MIN_SIZE = 60;
const COLUMN_MAX_SIZE = 1200;

// Auto-fit heuristic. Cells render in 12px monospace, so character count is a
// good proxy for width without measuring the DOM.
const CHAR_WIDTH = 7;
const CELL_CHROME = 18; // td padding (8+8) + borders
const HEADER_CHROME = 40; // th padding-right (sort indicator + filter icon) + borders
const AUTO_FIT_MAX_WIDTH = 300; // previous --cell-max-width, now the auto-fit cap
const AUTO_FIT_SAMPLE_ROWS = 50;

/**
 * Initial (and reset-to) width for a column, derived from its header plus a
 * sample of the loaded rows. Sampling a fixed prefix keeps widths stable as
 * more rows stream in via onFetchMore.
 */
function autoFitWidth(columnName: string, rows: Record<string, unknown>[]): number {
  let maxChars = columnName.length;
  const sampleSize = Math.min(rows.length, AUTO_FIT_SAMPLE_ROWS);
  for (let i = 0; i < sampleSize; i++) {
    const val = rows[i]?.[columnName];
    const len = val === null || val === undefined ? 4 : String(val).length; // "NULL"
    if (len > maxChars) maxChars = len;
  }
  const contentWidth = maxChars * CHAR_WIDTH + CELL_CHROME;
  const headerWidth = columnName.length * CHAR_WIDTH + HEADER_CHROME;
  const width = Math.max(contentWidth, headerWidth);
  return Math.round(Math.min(Math.max(width, COLUMN_MIN_SIZE), AUTO_FIT_MAX_WIDTH));
}

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
  columnFilterSelections,
  onApplyColumnFilter,
  onClearColumnFilter,
  onRenameColumn,
  onInsertColumn,
  onDeleteColumn,
  hasMore,
  isFetchingMore,
  onFetchMore,
}: ResultsTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
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
    onCellEdit(editingCell.rowIndex, Number(rowid), editingCell.columnName, editingCell.value);
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
      size: autoFitWidth(col.name, result.rows),
      minSize: COLUMN_MIN_SIZE,
      maxSize: COLUMN_MAX_SIZE,
      cell: (info) => {
        const val = info.getValue();
        if (val === null || val === undefined) return <span className="null-value">NULL</span>;
        return String(val);
      },
    }));
  }, [displayColumns, result?.rows]);

  const table = useReactTable({
    data: result?.rows ?? [],
    columns,
    state: { sorting, columnSizing },
    onSortingChange: setSorting,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    columnResizeDirection: 'ltr',
    defaultColumn: { minSize: COLUMN_MIN_SIZE, maxSize: COLUMN_MAX_SIZE },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const { rows } = table.getRowModel();

  // Drop user-set widths only when the column set itself changes (new table or
  // different projection). Re-running the same query, filtering, sorting or
  // paging in more rows all keep the same column ids, and so keep their widths.
  const columnSignature = useMemo(
    () => displayColumns.map((col) => col.name).join(' '),
    [displayColumns]
  );
  useEffect(() => {
    setColumnSizing((prev) => (Object.keys(prev).length > 0 ? {} : prev));
  }, [columnSignature]);

  // Widths are handed to the cells as CSS custom properties on the <table> rather
  // than as per-cell inline styles. With columnResizeMode 'onChange' every
  // mousemove re-renders this component, but each <th>/<td> style object stays
  // byte-identical ("width: var(--col-N-size)"), so React writes nothing to the
  // DOM for them and only the table's few custom properties actually change.
  const columnSizingInfo = table.getState().columnSizingInfo;
  const isResizing = Boolean(columnSizingInfo.isResizingColumn);
  const columnSizeVars = useMemo(() => {
    const vars: Record<string, string> = {};
    table.getFlatHeaders().forEach((header, index) => {
      vars[`--col-${index}-size`] = `${header.getSize()}px`;
    });
    return vars;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, columnSizing, columnSizingInfo]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 30,
  });

  // Infinite scroll: fetch more when near bottom
  useEffect(() => {
    const container = tableContainerRef.current;
    if (!container || !onFetchMore || !hasMore) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      if (scrollHeight - scrollTop - clientHeight < 500) {
        onFetchMore();
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [onFetchMore, hasMore]);

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

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems.length > 0 ? totalSize - virtualItems[virtualItems.length - 1].end : 0;
  const colSpan = displayColumns.length + 2; // + row number column + trailing filler
  // Explicit total keeps the browser honest about the horizontal scroll extent;
  // the filler column soaks up any slack when the columns are narrower than the pane.
  const totalWidth = table.getTotalSize() + ROW_NUMBER_WIDTH;

  const activeFilterEntries = columnFilters ? Array.from(columnFilters.entries()) : [];

  return (
    <div className="results-container">
      {activeFilterEntries.length > 0 && (
        <div className="active-filters-bar">
          <span className="active-filters-label">Filters:</span>
          {activeFilterEntries.map(([colName]) => (
            <span key={colName} className="active-filter-chip">
              {colName}
              {onClearColumnFilter && (
                <button
                  className="active-filter-remove"
                  onClick={() => onClearColumnFilter(colName)}
                  title={`Remove filter on ${colName}`}
                >
                  &times;
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div
        className={`virtual-table-container${isResizing ? ' is-resizing' : ''}`}
        ref={tableContainerRef}
      >
        <table style={{ ...columnSizeVars, minWidth: totalWidth }}>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                <th className="row-number-header">#</th>
                {headerGroup.headers.map((header, colIndex) => {
                  const colName = header.column.id;
                  const colType = typeMap.get(colName) ?? '';
                  const hasFilter = columnFilters?.has(colName);
                  return (
                    <th
                      key={header.id}
                      className={[
                        header.column.getIsSorted() ? 'sorted' : '',
                        hasFilter ? 'col-filtered' : '',
                      ].filter(Boolean).join(' ')}
                      style={{ width: `var(--col-${colIndex}-size)` }}
                      onContextMenu={(e) => handleHeaderContextMenu(e, colName)}
                    >
                      <div className="th-content" onClick={header.column.getToggleSortingHandler()}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() === 'asc' && <span className="sort-indicator sort-active" title="Sorted ascending">{' \u25B2'}</span>}
                        {header.column.getIsSorted() === 'desc' && <span className="sort-indicator sort-active" title="Sorted descending">{' \u25BC'}</span>}
                        {!header.column.getIsSorted() && <span className="sort-indicator sort-hint" title="Click to sort">{' \u25B2'}</span>}
                      </div>
                      {activeTable && (
                        <span
                          className={`col-filter-icon${hasFilter ? ' col-filter-icon-active' : ''}`}
                          onClick={(e) => handleFilterClick(e, colName, colType)}
                          title="Filter"
                        >
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M1 2h14l-5.5 6.5V14l-3-2v-3.5z"/>
                          </svg>
                        </span>
                      )}
                      {header.column.getCanResize() && (
                        <div
                          className={`col-resizer${header.column.getIsResizing() ? ' col-resizer-active' : ''}`}
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={`Resize ${colName}`}
                          title="Drag to resize, double-click to auto-fit"
                          onMouseDown={(e) => { e.stopPropagation(); header.getResizeHandler()(e); }}
                          onTouchStart={(e) => { e.stopPropagation(); header.getResizeHandler()(e); }}
                          onClick={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => { e.stopPropagation(); header.column.resetSize(); }}
                        />
                      )}
                    </th>
                  );
                })}
                {/* Absorbs leftover width so narrow results still fill the pane
                    without the fixed layout stretching every column. */}
                <th className="col-filler" aria-hidden="true" />
              </tr>
            ))}
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr><td colSpan={colSpan} style={{ height: paddingTop, padding: 0, border: 'none' }} /></tr>
            )}
            {virtualItems.map((virtualRow) => {
              const row = rows[virtualRow.index];
              const originalIndex = result.rows.indexOf(row.original);
              return (
                <tr key={row.id}>
                  <td className="row-number">{virtualRow.index + 1}</td>
                  {row.getVisibleCells().map((cell, colIndex) => {
                    const colName = cell.column.id;
                    const isSelected = selectedCells.has(cellKey(originalIndex, colName));
                    const isEditing = editingCell?.rowIndex === originalIndex && editingCell?.columnName === colName;
                    const cellWidth = `var(--col-${colIndex}-size)`;

                    if (isEditing) {
                      return (
                        <td key={cell.id} className="cell-editing" style={{ width: cellWidth }}>
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

                    const cellVal = row.original[colName];
                    const cellStr = cellVal === null || cellVal === undefined ? '' : String(cellVal);
                    return (
                      <td
                        key={cell.id}
                        className={isSelected ? 'cell-selected' : ''}
                        style={{ width: cellWidth }}
                        title={cellStr.length > 30 ? cellStr : undefined}
                        onClick={(e) => handleCellClick(e, originalIndex, colName)}
                        onDoubleClick={() => handleCellDoubleClick(originalIndex, colName, row.original[colName])}
                        onContextMenu={(e) => handleCellContextMenu(e, originalIndex, colName)}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                  <td className="col-filler" />
                </tr>
              );
            })}
            {paddingBottom > 0 && (
              <tr><td colSpan={colSpan} style={{ height: paddingBottom, padding: 0, border: 'none' }} /></tr>
            )}
            {isFetchingMore && (
              <tr><td colSpan={colSpan} style={{ textAlign: 'center', opacity: 0.6, padding: '8px' }}>Loading more rows...</td></tr>
            )}
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
          previousSelection={columnFilterSelections?.get(filterPanel.columnName)}
          onApplyFilter={(colName, clause, selection) => {
            onApplyColumnFilter?.(colName, clause, selection);
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
