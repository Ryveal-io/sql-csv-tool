interface ToolbarProps {
  onRun: () => void;
  isLoading: boolean;
  fileName: string;
  isDirty?: boolean;
  onSave?: () => void;
  onSaveAs?: () => void;
  onLoadOptions?: () => void;
  onFormat?: () => void;
  onToggleFindReplace?: () => void;
  showFindReplace?: boolean;
  hasActiveTable?: boolean;
}

export function Toolbar({ onRun, isLoading, fileName, isDirty, onSave, onSaveAs, onLoadOptions, onFormat, onToggleFindReplace, showFindReplace, hasActiveTable }: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <button className="toolbar-btn toolbar-btn-primary" onClick={onRun} disabled={isLoading}>
          Run (Ctrl+Enter)
        </button>
        {isDirty && onSave && (
          <button className="toolbar-btn" onClick={onSave}>
            Save
          </button>
        )}
        {hasActiveTable && onSaveAs && (
          <button className="toolbar-btn" onClick={onSaveAs}>
            Save As...
          </button>
        )}
        {hasActiveTable && onLoadOptions && (
          <button
            className="toolbar-btn"
            onClick={onLoadOptions}
            title="Re-read this file with a different delimiter, header or encoding"
          >
            Load Options...
          </button>
        )}
        {onFormat && (
          <button className="toolbar-btn" onClick={onFormat} title="Format SQL (Shift+Alt+F)">
            Format
          </button>
        )}
        {onToggleFindReplace && (
          <button
            className={`toolbar-btn${showFindReplace ? ' toolbar-btn-active' : ''}`}
            onClick={onToggleFindReplace}
            title="Find & Replace (Ctrl+H)"
          >
            Find & Replace
          </button>
        )}
      </div>
      <div className="toolbar-right">
        {isDirty && <span className="toolbar-dirty">unsaved changes</span>}
        {fileName && <span className="toolbar-filename">{fileName}</span>}
      </div>
    </div>
  );
}
