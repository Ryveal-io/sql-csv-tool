interface ToolbarProps {
  onRun: () => void;
  isLoading: boolean;
  fileName: string;
  isDirty?: boolean;
  onSave?: () => void;
  onSaveAs?: () => void;
  onToggleFindReplace?: () => void;
  showFindReplace?: boolean;
  hasActiveTable?: boolean;
}

export function Toolbar({ onRun, isLoading, fileName, isDirty, onSave, onSaveAs, onToggleFindReplace, showFindReplace, hasActiveTable }: ToolbarProps) {
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
