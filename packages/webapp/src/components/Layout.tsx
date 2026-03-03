import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';
import type { ReactNode } from 'react';

interface LayoutProps {
  toolbar: ReactNode;
  findReplaceBar?: ReactNode;
  sqlEditor: ReactNode;
  schemaPanel: ReactNode;
  resultsTable: ReactNode;
  statusBar: ReactNode;
}

export function Layout({ toolbar, findReplaceBar, sqlEditor, schemaPanel, resultsTable, statusBar }: LayoutProps) {
  return (
    <div className="app-container">
      {toolbar}
      {findReplaceBar}
      <PanelGroup direction="vertical" className="main-panels">
        <Panel defaultSize={40} minSize={15}>
          <PanelGroup direction="horizontal">
            <Panel defaultSize={80} minSize={30}>
              {sqlEditor}
            </Panel>
            <PanelResizeHandle className="resize-handle resize-handle-horizontal" />
            <Panel defaultSize={20} minSize={10}>
              {schemaPanel}
            </Panel>
          </PanelGroup>
        </Panel>
        <PanelResizeHandle className="resize-handle resize-handle-vertical" />
        <Panel defaultSize={60} minSize={20}>
          {resultsTable}
        </Panel>
      </PanelGroup>
      {statusBar}
    </div>
  );
}
