import type { QueryResult } from '../types/query';

interface StatusBarProps {
  result: QueryResult | null;
  totalRows?: number;
  totalQueryRows?: number | null;
}

export function StatusBar({ result, totalRows, totalQueryRows }: StatusBarProps) {
  const displayTotal = totalQueryRows ?? totalRows;
  return (
    <div className="status-bar">
      {result && (
        <>
          <span className="status-item">
            {displayTotal != null && displayTotal !== result.rowCount
              ? `${result.rowCount.toLocaleString()} of ${displayTotal.toLocaleString()} rows`
              : `${result.rowCount.toLocaleString()} row${result.rowCount !== 1 ? 's' : ''}`
            }
          </span>
          <span className="status-item">
            {result.queryTimeMs.toFixed(1)}ms
          </span>
          <span className="status-item">
            {result.columns.length} column{result.columns.length !== 1 ? 's' : ''}
          </span>
        </>
      )}
    </div>
  );
}
