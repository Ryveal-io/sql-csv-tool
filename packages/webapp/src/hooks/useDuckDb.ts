import { useState, useEffect, useRef } from 'react';
import { initDuckDb, loadCsvFromBytes } from '../services/duckdb';
import type { CsvLoadOptions } from '../types/dialect';

interface DuckDbState {
  isReady: boolean;
  isLoading: boolean;
  error: string | null;
}

export function useDuckDb() {
  const [state, setState] = useState<DuckDbState>({
    isReady: false,
    isLoading: true,
    error: null,
  });
  const initRef = useRef(false);
  const initPromiseRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    initPromiseRef.current = initDuckDb()
      .then(() => {
        setState({ isReady: true, isLoading: false, error: null });
      })
      .catch((err) => {
        setState({ isReady: false, isLoading: false, error: String(err) });
      });
  }, []);

  const loadFile = async (
    fileName: string,
    content: Uint8Array,
    options?: CsvLoadOptions
  ): Promise<string> => {
    // Wait for DuckDB to finish initializing before loading data
    if (initPromiseRef.current) {
      await initPromiseRef.current;
    }
    return await loadCsvFromBytes(fileName, content, options);
  };

  return { ...state, loadFile };
}
