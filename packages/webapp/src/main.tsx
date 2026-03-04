import React from 'react';
import ReactDOM from 'react-dom/client';
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import App from './App';
import './styles/globals.css';

// Use bundled Monaco instead of CDN (CDN is blocked by VS Code webview CSP)
loader.config({ monaco });

// Configure Monaco workers — use inline workers for VS Code webview compatibility
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
