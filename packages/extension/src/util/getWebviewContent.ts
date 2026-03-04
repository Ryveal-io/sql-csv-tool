import * as vscode from 'vscode';
import { getNonce } from './nonce';

export function getWebviewContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const nonce = getNonce();

  const webviewDistUri = vscode.Uri.joinPath(extensionUri, 'webview-dist');
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(webviewDistUri, 'assets', 'index.js')
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(webviewDistUri, 'assets', 'index.css')
  );
  const assetsBaseUri = webview.asWebviewUri(
    vscode.Uri.joinPath(webviewDistUri, 'assets')
  ).toString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net;
    script-src 'nonce-${nonce}' ${webview.cspSource} https://cdn.jsdelivr.net 'wasm-unsafe-eval';
    worker-src blob: ${webview.cspSource};
    font-src ${webview.cspSource} https://cdn.jsdelivr.net;
    img-src ${webview.cspSource} data:;
    connect-src ${webview.cspSource} https: data: blob:;
  ">
  <link href="${styleUri}" rel="stylesheet">
  <title>SQL CSV Chomper</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__WEBVIEW_ASSETS_BASE__ = "${assetsBaseUri}";</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
