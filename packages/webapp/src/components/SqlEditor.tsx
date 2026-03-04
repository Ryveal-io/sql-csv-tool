import Editor from '@monaco-editor/react';
import { useCallback, useRef, useEffect } from 'react';
import type { editor, IDisposable } from 'monaco-editor';
import type { QueryColumn } from '../types/query';
import { formatSql } from '../utils/sqlFormat';

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'ILIKE',
  'BETWEEN', 'ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN',
  'ON', 'AS', 'DISTINCT', 'ALL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'ALTER', 'DROP', 'TABLE', 'VIEW', 'INDEX',
  'NULL', 'IS', 'TRUE', 'FALSE',
  'ASC', 'DESC', 'WITH', 'RECURSIVE',
  'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT',
  'EXISTS', 'ANY', 'SOME',
  'OVER', 'PARTITION BY', 'ROWS', 'RANGE', 'UNBOUNDED', 'PRECEDING', 'FOLLOWING',
  'CAST', 'COALESCE', 'NULLIF',
  'FETCH', 'FIRST', 'NEXT', 'ONLY',
];

const DUCKDB_FUNCTIONS = [
  { name: 'COUNT', snippet: 'COUNT(${1:*})', detail: 'Aggregate: count rows' },
  { name: 'SUM', snippet: 'SUM(${1:column})', detail: 'Aggregate: sum values' },
  { name: 'AVG', snippet: 'AVG(${1:column})', detail: 'Aggregate: average' },
  { name: 'MIN', snippet: 'MIN(${1:column})', detail: 'Aggregate: minimum' },
  { name: 'MAX', snippet: 'MAX(${1:column})', detail: 'Aggregate: maximum' },
  { name: 'STRING_AGG', snippet: "STRING_AGG(${1:column}, '${2:,}')", detail: 'Aggregate: concatenate strings' },
  { name: 'LIST_AGG', snippet: 'LIST_AGG(${1:column})', detail: 'Aggregate: collect into list' },
  { name: 'COUNT_IF', snippet: 'COUNT_IF(${1:condition})', detail: 'Aggregate: conditional count' },
  { name: 'LENGTH', snippet: 'LENGTH(${1:str})', detail: 'String: length' },
  { name: 'LOWER', snippet: 'LOWER(${1:str})', detail: 'String: lowercase' },
  { name: 'UPPER', snippet: 'UPPER(${1:str})', detail: 'String: uppercase' },
  { name: 'TRIM', snippet: 'TRIM(${1:str})', detail: 'String: trim whitespace' },
  { name: 'LTRIM', snippet: 'LTRIM(${1:str})', detail: 'String: trim left' },
  { name: 'RTRIM', snippet: 'RTRIM(${1:str})', detail: 'String: trim right' },
  { name: 'REPLACE', snippet: "REPLACE(${1:str}, '${2:from}', '${3:to}')", detail: 'String: replace' },
  { name: 'SUBSTRING', snippet: 'SUBSTRING(${1:str}, ${2:start}, ${3:length})', detail: 'String: substring' },
  { name: 'CONCAT', snippet: 'CONCAT(${1:a}, ${2:b})', detail: 'String: concatenate' },
  { name: 'CONTAINS', snippet: "CONTAINS(${1:str}, '${2:search}')", detail: 'String: contains check' },
  { name: 'STARTS_WITH', snippet: "STARTS_WITH(${1:str}, '${2:prefix}')", detail: 'String: prefix check' },
  { name: 'REGEXP_MATCHES', snippet: "REGEXP_MATCHES(${1:str}, '${2:pattern}')", detail: 'String: regex match' },
  { name: 'REGEXP_REPLACE', snippet: "REGEXP_REPLACE(${1:str}, '${2:pattern}', '${3:replacement}')", detail: 'String: regex replace' },
  { name: 'ABS', snippet: 'ABS(${1:x})', detail: 'Math: absolute value' },
  { name: 'ROUND', snippet: 'ROUND(${1:x}, ${2:decimals})', detail: 'Math: round' },
  { name: 'CEIL', snippet: 'CEIL(${1:x})', detail: 'Math: ceiling' },
  { name: 'FLOOR', snippet: 'FLOOR(${1:x})', detail: 'Math: floor' },
  { name: 'POW', snippet: 'POW(${1:base}, ${2:exp})', detail: 'Math: power' },
  { name: 'SQRT', snippet: 'SQRT(${1:x})', detail: 'Math: square root' },
  { name: 'LOG', snippet: 'LOG(${1:x})', detail: 'Math: logarithm' },
  { name: 'LN', snippet: 'LN(${1:x})', detail: 'Math: natural log' },
  { name: 'STRFTIME', snippet: "STRFTIME(${1:timestamp}, '${2:%Y-%m-%d}')", detail: 'Date: format timestamp' },
  { name: 'DATE_TRUNC', snippet: "DATE_TRUNC('${1:month}', ${2:date})", detail: 'Date: truncate to unit' },
  { name: 'DATE_PART', snippet: "DATE_PART('${1:year}', ${2:date})", detail: 'Date: extract part' },
  { name: 'DATE_DIFF', snippet: "DATE_DIFF('${1:day}', ${2:start}, ${3:end})", detail: 'Date: difference' },
  { name: 'CURRENT_DATE', snippet: 'CURRENT_DATE', detail: 'Date: today' },
  { name: 'CURRENT_TIMESTAMP', snippet: 'CURRENT_TIMESTAMP', detail: 'Date: now' },
  { name: 'GENERATE_SERIES', snippet: 'GENERATE_SERIES(${1:start}, ${2:stop}, ${3:step})', detail: 'Generate series' },
  { name: 'UNNEST', snippet: 'UNNEST(${1:list})', detail: 'Expand list to rows' },
  { name: 'IF', snippet: 'IF(${1:condition}, ${2:true_val}, ${3:false_val})', detail: 'Conditional expression' },
  { name: 'IFNULL', snippet: 'IFNULL(${1:value}, ${2:default})', detail: 'Null coalesce (2 args)' },
  { name: 'READ_CSV_AUTO', snippet: "READ_CSV_AUTO('${1:path}')", detail: 'Read CSV file' },
  { name: 'DESCRIBE', snippet: 'DESCRIBE ${1:table}', detail: 'Show table schema' },
  { name: 'ROW_NUMBER', snippet: 'ROW_NUMBER() OVER (${1:ORDER BY col})', detail: 'Window: row number' },
  { name: 'RANK', snippet: 'RANK() OVER (${1:ORDER BY col})', detail: 'Window: rank' },
  { name: 'DENSE_RANK', snippet: 'DENSE_RANK() OVER (${1:ORDER BY col})', detail: 'Window: dense rank' },
  { name: 'LAG', snippet: 'LAG(${1:column}, ${2:1}) OVER (${3:ORDER BY col})', detail: 'Window: previous row' },
  { name: 'LEAD', snippet: 'LEAD(${1:column}, ${2:1}) OVER (${3:ORDER BY col})', detail: 'Window: next row' },
];

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  tableSchemas?: Record<string, QueryColumn[]>;
}

export function SqlEditor({ value, onChange, onRun, tableSchemas }: SqlEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null);
  const completionDisposableRef = useRef<IDisposable | null>(null);
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  const detectTheme = useCallback((): string => {
    if (document.body.classList.contains('vscode-light')) return 'vs';
    if (document.body.classList.contains('vscode-high-contrast')) return 'hc-black';
    return 'vs-dark';
  }, []);

  // Register/update completion provider when table schemas change
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    // Dispose previous provider
    completionDisposableRef.current?.dispose();

    const schemas = tableSchemas ?? {};
    const tableNames = Object.keys(schemas);

    // Collect all columns across all tables (deduplicated)
    const allColumns = new Map<string, string>();
    for (const cols of Object.values(schemas)) {
      for (const col of cols) {
        allColumns.set(col.name, col.type);
      }
    }

    completionDisposableRef.current = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', ' '],
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        // Check if we're after "tablename." for column completions
        const lineContent = model.getLineContent(position.lineNumber);
        const textBeforeCursor = lineContent.slice(0, position.column - 1);

        for (const tableName of tableNames) {
          const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = new RegExp(`(?:\\b${escaped}|"${escaped}")\\.([\\w]*)$`, 'i');
          const match = textBeforeCursor.match(pattern);
          if (match) {
            const dotRange = {
              ...range,
              startColumn: position.column - (match[1]?.length ?? 0),
            };
            const tableColumns = schemas[tableName] ?? [];
            return {
              suggestions: tableColumns.map((col) => ({
                label: col.name,
                kind: monaco.languages.CompletionItemKind.Field,
                detail: `${tableName}.${col.name}: ${col.type}`,
                insertText: /^[a-zA-Z_]\w*$/.test(col.name) ? col.name : `"${col.name}"`,
                range: dotRange,
              })),
            };
          }
        }

        const suggestions = [
          // SQL keywords
          ...SQL_KEYWORDS.map((kw) => ({
            label: kw,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: kw,
            range,
          })),

          // Table names
          ...tableNames.map((name) => ({
            label: name,
            kind: monaco.languages.CompletionItemKind.Struct,
            detail: `Table (${schemas[name]?.length ?? 0} columns)`,
            insertText: /^[a-zA-Z_]\w*$/.test(name) ? name : `"${name}"`,
            range,
          })),

          // All column names (unqualified)
          ...Array.from(allColumns.entries()).map(([name, type]) => ({
            label: name,
            kind: monaco.languages.CompletionItemKind.Field,
            detail: type,
            insertText: /^[a-zA-Z_]\w*$/.test(name) ? name : `"${name}"`,
            range,
          })),

          // DuckDB functions
          ...DUCKDB_FUNCTIONS.map((fn) => ({
            label: fn.name,
            kind: monaco.languages.CompletionItemKind.Function,
            detail: fn.detail,
            insertText: fn.snippet,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          })),
        ];

        return { suggestions };
      },
    });

    return () => {
      completionDisposableRef.current?.dispose();
      completionDisposableRef.current = null;
    };
  }, [tableSchemas]);

  return (
    <div className="sql-editor-container">
      <Editor
        defaultLanguage="sql"
        value={value}
        onChange={(val) => onChange(val ?? '')}
        theme={detectTheme()}
        options={{
          minimap: { enabled: false },
          lineNumbers: 'on',
          fontSize: 13,
          wordWrap: 'on',
          automaticLayout: true,
          scrollBeyondLastLine: false,
          padding: { top: 8 },
          suggest: {
            showKeywords: true,
            showFunctions: true,
            showFields: true,
          },
          quickSuggestions: {
            other: true,
            strings: false,
            comments: false,
          },
        }}
        onMount={(editor, monaco) => {
          editorRef.current = editor;
          monacoRef.current = monaco;

          editor.addAction({
            id: 'run-query',
            label: 'Run Query',
            keybindings: [
              monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
            ],
            run: () => onRunRef.current(),
          });

          editor.addAction({
            id: 'format-sql',
            label: 'Format SQL',
            keybindings: [
              monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
            ],
            run: (ed) => {
              const currentValue = ed.getValue();
              const formatted = formatSql(currentValue);
              if (formatted !== currentValue) {
                ed.setValue(formatted);
                onChange(formatted);
              }
            },
          });
        }}
      />
    </div>
  );
}
