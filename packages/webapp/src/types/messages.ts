// Messages FROM extension host TO webview
export type ExtensionToWebviewMessage =
  | { type: 'load'; fileName: string; content: number[] }
  | { type: 'requestExport' }
  | { type: 'setSql'; sql: string }
  | { type: 'runQuery'; sql: string }
  | { type: 'reload' };

// Messages FROM webview TO extension host
export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'csvData'; content: number[] }
  | { type: 'saveTable'; fileName: string; content: number[] }
  | { type: 'error'; message: string };
