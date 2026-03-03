import { useState, useCallback, useRef } from 'react';
import { executeQuery, executeCountQuery } from '../services/duckdb';
import { hasExplicitLimit, buildChunkedQuery, buildCountQuery, CHUNK_SIZE } from '../utils/sqlAnalysis';
import type { QueryResult } from '../types/query';

export function useQueryExecution() {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [totalQueryRows, setTotalQueryRows] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);

  // Track chunking state across fetches
  const chunkRef = useRef<{
    baseSql: string;
    offset: number;
    generation: number;
  } | null>(null);
  const generationRef = useRef(0);

  const runQuery = useCallback(async (sql: string) => {
    setError(null);
    setIsExecuting(true);
    setHasMore(false);
    setTotalQueryRows(null);

    const gen = ++generationRef.current;

    try {
      const userHasLimit = hasExplicitLimit(sql);

      if (userHasLimit) {
        const r = await executeQuery(sql);
        if (gen !== generationRef.current) return; // stale
        chunkRef.current = null;
        setResult(r);
        setHasMore(false);
      } else {
        // No explicit LIMIT — silently chunk + count in parallel
        const chunkedSql = buildChunkedQuery(sql, 0);
        const countSql = buildCountQuery(sql);

        const [queryResult, totalCount] = await Promise.all([
          executeQuery(chunkedSql),
          executeCountQuery(countSql).catch(() => null),
        ]);

        if (gen !== generationRef.current) return; // stale

        chunkRef.current = {
          baseSql: sql,
          offset: queryResult.rows.length,
          generation: gen,
        };

        setResult(queryResult);
        setTotalQueryRows(totalCount);
        setHasMore(totalCount !== null && queryResult.rows.length < totalCount);
      }
    } catch (err: unknown) {
      if (gen !== generationRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === generationRef.current) {
        setIsExecuting(false);
      }
    }
  }, []);

  const fetchMore = useCallback(async () => {
    const chunk = chunkRef.current;
    if (!chunk || isFetchingMore || !hasMore) return;

    const gen = chunk.generation;
    if (gen !== generationRef.current) return;

    setIsFetchingMore(true);
    try {
      const chunkedSql = buildChunkedQuery(chunk.baseSql, chunk.offset, CHUNK_SIZE);
      const moreResult = await executeQuery(chunkedSql);

      if (gen !== generationRef.current) return; // stale

      if (moreResult.rows.length === 0) {
        setHasMore(false);
      } else {
        chunk.offset += moreResult.rows.length;
        setHasMore(chunk.offset < (totalQueryRows ?? Infinity));

        setResult(prev => {
          if (!prev) return moreResult;
          return {
            ...prev,
            rows: [...prev.rows, ...moreResult.rows],
            rowCount: prev.rowCount + moreResult.rowCount,
          };
        });
      }
    } catch (err: unknown) {
      if (gen === generationRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (gen === generationRef.current) {
        setIsFetchingMore(false);
      }
    }
  }, [isFetchingMore, hasMore, totalQueryRows]);

  const updateRow = useCallback((rowIndex: number, columnName: string, newValue: unknown) => {
    setResult(prev => {
      if (!prev) return prev;
      const newRows = [...prev.rows];
      newRows[rowIndex] = { ...newRows[rowIndex], [columnName]: newValue };
      return { ...prev, rows: newRows };
    });
  }, []);

  return {
    result,
    totalQueryRows,
    hasMore,
    error,
    isExecuting,
    isFetchingMore,
    runQuery,
    fetchMore,
    updateRow,
  };
}
