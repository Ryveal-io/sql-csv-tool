import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { CsvDialect, CsvLoadOptions } from '../types/dialect';

interface LoadOptionsDialogProps {
  /** What detection came up with, used to prefill the form. */
  dialect?: CsvDialect;
  fileName: string;
  onReload: (options: CsvLoadOptions) => void;
  onClose: () => void;
  /** Why the last reload attempt failed, if it did. */
  error?: string | null;
  /** True while a reload is in flight. */
  isReloading?: boolean;
}

const DELIMITER_PRESETS = [
  { label: 'Comma (,)', value: ',' },
  { label: 'Tab (\\t)', value: '\t' },
  { label: 'Pipe (|)', value: '|' },
  { label: 'Semicolon (;)', value: ';' },
];

const NEWLINE_PRESETS = [
  { label: 'Detect', value: '' },
  { label: 'LF (\\n)', value: '\\n' },
  { label: 'CRLF (\\r\\n)', value: '\\r\\n' },
  { label: 'CR (\\r)', value: '\\r' },
];

// The only encodings DuckDB's CSV reader accepts.
const ENCODINGS = [
  { label: 'UTF-8', value: 'utf-8' },
  { label: 'Latin-1', value: 'latin-1' },
  { label: 'UTF-16', value: 'utf-16' },
];

/** Render a delimiter for display, so a tab isn't an invisible blank. */
function describeDelimiter(value: string): string {
  if (value === '\t') return '\\t';
  if (value === ' ') return '(space)';
  return value;
}

export function LoadOptionsDialog({
  dialect,
  fileName,
  onReload,
  onClose,
  error,
  isReloading = false,
}: LoadOptionsDialogProps) {
  const detected = dialect?.delimiter ?? ',';
  const isPreset = DELIMITER_PRESETS.some(p => p.value === detected);

  // What the form was seeded with. Fields still holding these values are ones
  // the user never had an opinion about, so they are left out of the overrides
  // and re-detected instead. Detection produced them as a set: once the user
  // corrects one, the rest of the set stops being evidence of anything.
  const prefill = useMemo(() => ({
    hasHeader: dialect?.hasHeader ?? true,
    quote: dialect?.quote ?? '"',
    escape: dialect?.escape ?? '"',
    skipRows: String(dialect?.skipRows ?? 0),
    encoding: dialect?.encoding ?? 'utf-8',
  }), [dialect]);

  const [delimiter, setDelimiter] = useState(isPreset ? detected : ',');
  const [customDelimiter, setCustomDelimiter] = useState(isPreset ? '' : detected);
  const [useCustom, setUseCustom] = useState(!isPreset);
  const [hasHeader, setHasHeader] = useState(prefill.hasHeader);
  const [quote, setQuote] = useState(prefill.quote);
  const [escape, setEscape] = useState(prefill.escape);
  const [newline, setNewline] = useState('');
  const [skipRows, setSkipRows] = useState(prefill.skipRows);
  const [encoding, setEncoding] = useState(prefill.encoding);
  const [allVarchar, setAllVarchar] = useState(false);
  const [ignoreErrors, setIgnoreErrors] = useState(false);

  const overlayRef = useRef<HTMLDivElement>(null);
  const effectiveDelimiter = useCustom ? customDelimiter : delimiter;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  const handleReload = useCallback(() => {
    if (!effectiveDelimiter || isReloading) return;
    const parsedSkip = parseInt(skipRows, 10);
    onReload({
      delimiter: effectiveDelimiter,
      ...(hasHeader !== prefill.hasHeader && { hasHeader }),
      ...(quote !== prefill.quote && { quote }),
      ...(escape !== prefill.escape && { escape }),
      ...(newline && { newline }),
      ...(skipRows !== prefill.skipRows && {
        skipRows: Number.isFinite(parsedSkip) && parsedSkip >= 0 ? parsedSkip : 0,
      }),
      ...(encoding !== prefill.encoding && { encoding }),
      ...(allVarchar && { allVarchar }),
      ...(ignoreErrors && { ignoreErrors }),
    });
  }, [prefill, effectiveDelimiter, hasHeader, quote, escape, newline, skipRows, encoding, allVarchar, ignoreErrors, isReloading, onReload]);

  return (
    <div className="save-as-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="save-as-dialog">
        <h3>Load Options</h3>
        <p className="load-options-hint">
          Re-reads <strong>{fileName}</strong> from source. Any unsaved edits to this table are discarded.
          {dialect && <> Detected delimiter: <code>{describeDelimiter(dialect.delimiter)}</code>.</>}
        </p>

        <div className="save-as-section">
          <label className="save-as-label">Column delimiter</label>
          <div className="save-as-options">
            {DELIMITER_PRESETS.map((preset) => (
              <label key={preset.value} className="save-as-radio">
                <input
                  type="radio"
                  name="load-delimiter"
                  checked={!useCustom && delimiter === preset.value}
                  onChange={() => { setUseCustom(false); setDelimiter(preset.value); }}
                />
                {preset.label}
              </label>
            ))}
            <label className="save-as-radio">
              <input
                type="radio"
                name="load-delimiter"
                checked={useCustom}
                onChange={() => setUseCustom(true)}
              />
              Custom:
              <input
                type="text"
                className="save-as-custom-input"
                value={customDelimiter}
                onChange={(e) => { setCustomDelimiter(e.target.value); setUseCustom(true); }}
                maxLength={3}
                placeholder="..."
              />
            </label>
          </div>
        </div>

        <div className="save-as-section">
          <label className="save-as-label">Row delimiter</label>
          <div className="save-as-options">
            {NEWLINE_PRESETS.map((preset) => (
              <label key={preset.label} className="save-as-radio">
                <input
                  type="radio"
                  name="load-newline"
                  checked={newline === preset.value}
                  onChange={() => setNewline(preset.value)}
                />
                {preset.label}
              </label>
            ))}
          </div>
        </div>

        <div className="save-as-section">
          <label className="save-as-label">Quoting</label>
          <div className="save-as-options save-as-options-inline">
            <label className="save-as-radio">
              Quote char:
              <input
                type="text"
                className="save-as-custom-input"
                value={quote}
                onChange={(e) => setQuote(e.target.value)}
                maxLength={1}
                placeholder="none"
              />
            </label>
            <label className="save-as-radio">
              Escape char:
              <input
                type="text"
                className="save-as-custom-input"
                value={escape}
                onChange={(e) => setEscape(e.target.value)}
                maxLength={1}
                placeholder="none"
              />
            </label>
          </div>
        </div>

        <div className="save-as-section">
          <label className="save-as-label">Encoding</label>
          <div className="save-as-options">
            {ENCODINGS.map((enc) => (
              <label key={enc.value} className="save-as-radio">
                <input
                  type="radio"
                  name="load-encoding"
                  checked={encoding === enc.value}
                  onChange={() => setEncoding(enc.value)}
                />
                {enc.label}
              </label>
            ))}
          </div>
        </div>

        <div className="save-as-section">
          <label className="save-as-label">Options</label>
          <div className="save-as-options">
            <label className="save-as-checkbox">
              <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
              First row is a header
            </label>
            <label className="save-as-checkbox">
              <input type="checkbox" checked={allVarchar} onChange={(e) => setAllVarchar(e.target.checked)} />
              Read every column as text (no type inference)
            </label>
            <label className="save-as-checkbox">
              <input type="checkbox" checked={ignoreErrors} onChange={(e) => setIgnoreErrors(e.target.checked)} />
              Skip malformed rows
            </label>
            <label className="save-as-radio">
              Skip rows before header:
              <input
                type="text"
                className="save-as-custom-input"
                value={skipRows}
                onChange={(e) => setSkipRows(e.target.value.replace(/[^0-9]/g, ''))}
                maxLength={4}
              />
            </label>
          </div>
        </div>

        {error && (
          <div className="load-options-error" role="alert">
            Reload failed — the file was left as it was.
            <pre>{error}</pre>
          </div>
        )}

        <div className="save-as-actions">
          <button className="toolbar-btn" onClick={onClose} disabled={isReloading}>Cancel</button>
          <button
            className="toolbar-btn toolbar-btn-primary"
            onClick={handleReload}
            disabled={!effectiveDelimiter || isReloading}
          >
            {isReloading ? 'Reloading…' : 'Reload'}
          </button>
        </div>
      </div>
    </div>
  );
}
