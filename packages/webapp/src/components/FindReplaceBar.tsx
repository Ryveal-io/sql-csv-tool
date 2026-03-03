import { useState, useCallback, useRef, useEffect } from 'react';
import { countMatches } from '../services/duckdb';
import type { TableInfo } from '../types/query';

interface FindReplaceBarProps {
  tables: TableInfo[];
  activeTable: string | null;
  onReplace: (tableName: string, columnName: string | null, find: string, replace: string, options: { caseSensitive: boolean; regex: boolean }) => void;
  onClose: () => void;
}

export function FindReplaceBar({ tables, activeTable, onReplace, onClose }: FindReplaceBarProps) {
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [selectedColumn, setSelectedColumn] = useState<string>('__all__');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [replacing, setReplacing] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const findInputRef = useRef<HTMLInputElement>(null);

  const activeTableInfo = tables.find(t => t.name === activeTable);
  const columns = activeTableInfo?.columns ?? [];

  // Focus find input on mount
  useEffect(() => {
    findInputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Debounced match count
  useEffect(() => {
    if (!activeTable || !findText.trim()) {
      setMatchCount(null);
      return;
    }

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const col = selectedColumn === '__all__' ? null : selectedColumn;
        const count = await countMatches(activeTable, col, findText, { caseSensitive, regex });
        setMatchCount(count);
      } catch {
        setMatchCount(null);
      }
    }, 300);

    return () => clearTimeout(debounceRef.current);
  }, [activeTable, findText, selectedColumn, caseSensitive, regex]);

  const handleReplace = useCallback(async () => {
    if (!activeTable || !findText.trim()) return;
    setReplacing(true);
    try {
      const col = selectedColumn === '__all__' ? null : selectedColumn;
      if (col) {
        onReplace(activeTable, col, findText, replaceText, { caseSensitive, regex });
      } else {
        // Replace in all text columns
        for (const c of columns) {
          if (/VARCHAR|TEXT|STRING|CHAR/i.test(c.type)) {
            onReplace(activeTable, c.name, findText, replaceText, { caseSensitive, regex });
          }
        }
      }
      setMatchCount(0);
    } finally {
      setReplacing(false);
    }
  }, [activeTable, findText, replaceText, selectedColumn, caseSensitive, regex, columns, onReplace]);

  if (!activeTable) return null;

  return (
    <div className="find-replace-bar">
      <select
        className="find-replace-column"
        value={selectedColumn}
        onChange={(e) => setSelectedColumn(e.target.value)}
      >
        <option value="__all__">All Columns</option>
        {columns.map(c => (
          <option key={c.name} value={c.name}>{c.name}</option>
        ))}
      </select>

      <input
        ref={findInputRef}
        className="find-replace-input"
        type="text"
        placeholder="Find..."
        value={findText}
        onChange={(e) => setFindText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleReplace(); }}
      />

      <input
        className="find-replace-input"
        type="text"
        placeholder="Replace..."
        value={replaceText}
        onChange={(e) => setReplaceText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleReplace(); }}
      />

      <label className="find-replace-option" title="Case sensitive">
        <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
        Aa
      </label>

      <label className="find-replace-option" title="Regular expression">
        <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
        .*
      </label>

      {matchCount !== null && (
        <span className="find-replace-count">
          {matchCount} match{matchCount !== 1 ? 'es' : ''}
        </span>
      )}

      <button
        className="toolbar-btn toolbar-btn-primary"
        onClick={handleReplace}
        disabled={!findText.trim() || replacing}
      >
        Replace All
      </button>

      <button className="find-replace-close" onClick={onClose} title="Close">{'\u2715'}</button>
    </div>
  );
}
