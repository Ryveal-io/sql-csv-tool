/**
 * The CSV dialect of a source file, as detected by DuckDB's `sniff_csv()` or
 * overridden by the user at load time.
 *
 * This is what lets us write a file back out the way it came in. Without it a
 * pipe-delimited file loads fine and then saves as comma-delimited, silently
 * corrupting the original.
 */
export interface CsvDialect {
  delimiter: string;
  quote: string;
  escape: string;
  /** Row delimiter. DuckDB reports `\n`, `\r\n` or `\r`. */
  newline: string;
  hasHeader: boolean;
  skipRows: number;
  dateFormat?: string;
  timestampFormat?: string;
  /** DuckDB accepts utf-8, utf-16 and latin-1 only. */
  encoding?: string;
}

/**
 * User-supplied load overrides. Anything left undefined falls back to the
 * sniffed value, so callers only specify what DuckDB got wrong.
 */
export interface CsvLoadOptions {
  delimiter?: string;
  quote?: string;
  escape?: string;
  newline?: string;
  hasHeader?: boolean;
  skipRows?: number;
  encoding?: string;
  dateFormat?: string;
  /** Read every column as VARCHAR, bypassing type inference. */
  allVarchar?: boolean;
  /** Skip malformed rows instead of failing the whole load. */
  ignoreErrors?: boolean;
}

export const DEFAULT_DIALECT: CsvDialect = {
  delimiter: ',',
  quote: '"',
  escape: '"',
  newline: '\n',
  hasHeader: true,
  skipRows: 0,
};

/** Map a delimiter to the file extension it conventionally implies. */
export function extensionForDelimiter(delimiter: string): string {
  if (delimiter === '\t') return '.tsv';
  if (delimiter === ',') return '.csv';
  return '.txt';
}

/**
 * `sniff_csv()` reports absent quote/escape characters as the literal string
 * "(empty)" rather than an empty string, so it needs normalizing before the
 * value is round-tripped back into a COPY statement.
 */
export function normalizeSniffed(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return s === '(empty)' ? '' : s;
}
