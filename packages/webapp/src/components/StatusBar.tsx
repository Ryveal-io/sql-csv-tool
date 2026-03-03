import type { QueryResult } from '../types/query';

interface StatusBarProps {
  result: QueryResult | null;
  totalRows?: number;
}

export function StatusBar({ result, totalRows }: StatusBarProps) {
  return (
    <div className="status-bar">
      {result && (
        <>
          <span className="status-item">
            {totalRows != null && totalRows !== result.rowCount
              ? `${result.rowCount.toLocaleString()} of ${totalRows.toLocaleString()} rows`
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
