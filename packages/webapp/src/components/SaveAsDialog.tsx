import { useState, useCallback, useEffect, useRef } from 'react';
import type { CsvDialect } from '../types/dialect';
import { extensionForDelimiter } from '../types/dialect';

export interface SaveAsOptions {
  delimiter: string;
  quoteStyle: 'always' | 'as-needed' | 'never';
  includeHeader: boolean;
  includeRowNumbers: boolean;
  fileExtension: string;
}

interface SaveAsDialogProps {
  /** Dialect of the source file, used to default the form to its format. */
  dialect?: CsvDialect;
  onSave: (options: SaveAsOptions) => void;
  onClose: () => void;
}

const DELIMITER_PRESETS = [
  { label: 'Comma (,)', value: ',' },
  { label: 'Tab (\\t)', value: '\t' },
  { label: 'Pipe (|)', value: '|' },
  { label: 'Semicolon (;)', value: ';' },
];

export function SaveAsDialog({ dialect, onSave, onClose }: SaveAsDialogProps) {
  // Default to the source file's own format: someone saving a pipe-delimited
  // file is far more often keeping it than converting it to CSV.
  const sourceDelimiter = dialect?.delimiter ?? ',';
  const isPreset = DELIMITER_PRESETS.some(p => p.value === sourceDelimiter);

  const [delimiter, setDelimiter] = useState(isPreset ? sourceDelimiter : ',');
  const [customDelimiter, setCustomDelimiter] = useState(isPreset ? '' : sourceDelimiter);
  const [useCustom, setUseCustom] = useState(!isPreset);
  const [quoteStyle, setQuoteStyle] = useState<SaveAsOptions['quoteStyle']>('as-needed');
  const [includeHeader, setIncludeHeader] = useState(dialect?.hasHeader ?? true);
  const [includeRowNumbers, setIncludeRowNumbers] = useState(false);
  const [fileExtension, setFileExtension] = useState(extensionForDelimiter(sourceDelimiter));

  const overlayRef = useRef<HTMLDivElement>(null);

  const effectiveDelimiter = useCustom ? customDelimiter : delimiter;

  // Auto-update extension when delimiter changes
  useEffect(() => {
    if (!useCustom) {
      setFileExtension(extensionForDelimiter(delimiter));
    }
  }, [delimiter, useCustom]);

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

  const handleSave = useCallback(() => {
    if (!effectiveDelimiter) return;
    onSave({
      delimiter: effectiveDelimiter,
      quoteStyle,
      includeHeader,
      includeRowNumbers,
      fileExtension,
    });
  }, [effectiveDelimiter, quoteStyle, includeHeader, includeRowNumbers, fileExtension, onSave]);

  return (
    <div className="save-as-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="save-as-dialog">
        <h3>Save As</h3>

        <div className="save-as-section">
          <label className="save-as-label">Delimiter</label>
          <div className="save-as-options">
            {DELIMITER_PRESETS.map((preset) => (
              <label key={preset.value} className="save-as-radio">
                <input
                  type="radio"
                  name="delimiter"
                  checked={!useCustom && delimiter === preset.value}
                  onChange={() => { setUseCustom(false); setDelimiter(preset.value); }}
                />
                {preset.label}
              </label>
            ))}
            <label className="save-as-radio">
              <input
                type="radio"
                name="delimiter"
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
          <label className="save-as-label">Quoting</label>
          <div className="save-as-options">
            <label className="save-as-radio">
              <input type="radio" name="quote" checked={quoteStyle === 'always'} onChange={() => setQuoteStyle('always')} />
              Always quote fields
            </label>
            <label className="save-as-radio">
              <input type="radio" name="quote" checked={quoteStyle === 'as-needed'} onChange={() => setQuoteStyle('as-needed')} />
              Quote as needed
            </label>
            <label className="save-as-radio">
              <input type="radio" name="quote" checked={quoteStyle === 'never'} onChange={() => setQuoteStyle('never')} />
              Never quote
            </label>
          </div>
        </div>

        <div className="save-as-section">
          <label className="save-as-label">Options</label>
          <div className="save-as-options">
            <label className="save-as-checkbox">
              <input type="checkbox" checked={includeHeader} onChange={(e) => setIncludeHeader(e.target.checked)} />
              Include header row
            </label>
            <label className="save-as-checkbox">
              <input type="checkbox" checked={includeRowNumbers} onChange={(e) => setIncludeRowNumbers(e.target.checked)} />
              Include row numbers
            </label>
          </div>
        </div>

        <div className="save-as-section">
          <label className="save-as-label">File extension</label>
          <div className="save-as-options">
            {['.csv', '.tsv', '.txt'].map((ext) => (
              <label key={ext} className="save-as-radio">
                <input type="radio" name="ext" checked={fileExtension === ext} onChange={() => setFileExtension(ext)} />
                {ext}
              </label>
            ))}
          </div>
        </div>

        <div className="save-as-actions">
          <button className="toolbar-btn" onClick={onClose}>Cancel</button>
          <button className="toolbar-btn toolbar-btn-primary" onClick={handleSave} disabled={!effectiveDelimiter}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
