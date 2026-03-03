export interface QueryColumn {
  name: string;
  type: string;
}

export interface TableInfo {
  name: string;          // SQL table name (sanitized filename stem)
  fileName: string;      // Original filename
  columns: QueryColumn[];
  rowCount: number;      // Total rows in the table
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
  queryTimeMs: number;
}
