import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { useMemo, useState, useCallback, useRef } from 'react';
import type { QueryResult, QueryColumn } from '../types/query';
import { CellContextMenu, type SelectedCell } from './CellContextMenu';
import { ColumnProfilePopover } from './ColumnProfilePopover';

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

interface ResultsTableProps {
  result: QueryResult | null;
  error: string | null;
  isLoading: boolean;
  columnTypes?: QueryColumn[];
  onFilter?: (filterClause: string) => void;
  editable?: boolean;
  onCellEdit?: (rowid: number, columnName: string, newValue: string) => void;
  activeTable?: string | null;
}

function cellKey(rowIndex: number, columnName: string): string {
  return `${rowIndex}:${columnName}`;
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
}: ResultsTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selectedCells, setSelectedCells] = useState<Map<string, CellId>>(new Map());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);

  // Column profile hover state
  const [hoveredColumn, setHoveredColumn] = useState<{
    name: string;
    type: string;
    rect: DOMRect;
  } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const closeTimerRef = useRef<ReturnType<typeof setTimeout>>();

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
          if (next.has(key)) {
            next.delete(key);
          } else {
            next.set(key, { rowIndex, columnName });
          }
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

  // Header hover handlers for profile popover
  const handleHeaderMouseEnter = useCallback((e: React.MouseEvent<HTMLTableCellElement>, colName: string, colType: string) => {
    if (!activeTable) return;
    clearTimeout(closeTimerRef.current);
    const target = e.currentTarget;
    hoverTimerRef.current = setTimeout(() => {
      const rect = target.getBoundingClientRect();
      setHoveredColumn({ name: colName, type: colType, rect });
    }, 300);
  }, [activeTable]);

  const handleHeaderMouseLeave = useCallback(() => {
    clearTimeout(hoverTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      setHoveredColumn(null);
    }, 200);
  }, []);

  const handlePopoverMouseEnter = useCallback(() => {
    clearTimeout(closeTimerRef.current);
  }, []);

  const handlePopoverMouseLeave = useCallback(() => {
    closeTimerRef.current = setTimeout(() => {
      setHoveredColumn(null);
    }, 200);
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
      header: () => (
        <span title={col.type}>{col.name}</span>
      ),
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
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: { pageSize: 100 },
    },
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
      <div className="table-wrapper">
        <table>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                <th className="row-number-header">#</th>
                {headerGroup.headers.map((header) => {
                  const colName = header.column.id;
                  const colType = typeMap.get(colName) ?? '';
                  return (
                    <th
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      className={header.column.getIsSorted() ? 'sorted' : ''}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={(e) => handleHeaderMouseEnter(e, colName, colType)}
                      onMouseLeave={handleHeaderMouseLeave}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {{ asc: ' \u25B2', desc: ' \u25BC' }[header.column.getIsSorted() as string] ?? ''}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const originalIndex = result.rows.indexOf(row.original);
              return (
                <tr key={row.id}>
                  <td className="row-number">
                    {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + row.index + 1}
                  </td>
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
      {table.getPageCount() > 1 && (
        <div className="pagination">
          <button onClick={() => table.firstPage()} disabled={!table.getCanPreviousPage()}>
            &laquo;
          </button>
          <button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            &lsaquo; Prev
          </button>
          <span className="pagination-info">
            Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
          </span>
          <button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            Next &rsaquo;
          </button>
          <button onClick={() => table.lastPage()} disabled={!table.getCanNextPage()}>
            &raquo;
          </button>
        </div>
      )}
      {contextMenu && selectedCellData.length > 0 && (
        <CellContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          selectedCells={selectedCellData}
          onFilter={handleFilter}
          onClose={() => setContextMenu(null)}
        />
      )}
      {hoveredColumn && activeTable && (
        <ColumnProfilePopover
          tableName={activeTable}
          columnName={hoveredColumn.name}
          columnType={hoveredColumn.type}
          anchorRect={hoveredColumn.rect}
          onMouseEnter={handlePopoverMouseEnter}
          onMouseLeave={handlePopoverMouseLeave}
        />
      )}
    </div>
  );
}
