import * as vscode from 'vscode';
import { CsvDocument } from './csvDocument';
import { getWebviewContent } from './util/getWebviewContent';

export class CsvEditorProvider implements vscode.CustomEditorProvider<CsvDocument> {
  private static readonly viewType = 'sqlCsvTool.csvEditor';
  private static _instance: CsvEditorProvider | null = null;

  // Track active webview panels for bridge access
  private readonly _activeWebviews = new Map<string, vscode.WebviewPanel>();

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new CsvEditorProvider(context);
    CsvEditorProvider._instance = provider;
    return vscode.window.registerCustomEditorProvider(
      CsvEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  public static get instance(): CsvEditorProvider | null {
    return CsvEditorProvider._instance;
  }

  /** Send a message to the most recently active webview */
  public sendToActiveWebview(message: unknown): boolean {
    // Find the active or most recent webview
    for (const [, panel] of this._activeWebviews) {
      if (panel.active) {
        panel.webview.postMessage(message);
        return true;
      }
    }
    // Fall back to any webview
    const first = this._activeWebviews.values().next().value;
    if (first) {
      first.webview.postMessage(message);
      return true;
    }
    return false;
  }

  /** Get info about the active editor */
  public getActiveEditorInfo(): { hasActiveEditor: boolean; fileName?: string } {
    for (const [uri, panel] of this._activeWebviews) {
      if (panel.active) {
        return { hasActiveEditor: true, fileName: uri.split('/').pop() };
      }
    }
    if (this._activeWebviews.size > 0) {
      const firstUri = this._activeWebviews.keys().next().value;
      return { hasActiveEditor: true, fileName: firstUri?.split('/').pop() };
    }
    return { hasActiveEditor: false };
  }

  private constructor(private readonly context: vscode.ExtensionContext) {}

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<CsvDocument>
  >();
  readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<CsvDocument> {
    return CsvDocument.create(uri);
  }

  async resolveCustomEditor(
    document: CsvDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const uriKey = document.uri.toString();
    this._activeWebviews.set(uriKey, webviewPanel);

    webviewPanel.onDidDispose(() => {
      this._activeWebviews.delete(uriKey);
    });

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'webview-dist'),
      ],
    };

    webviewPanel.webview.html = getWebviewContent(
      webviewPanel.webview,
      this.context.extensionUri
    );

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready': {
          const bytes = document.content;
          const fileName = document.uri.path.split('/').pop() ?? 'data.csv';
          webviewPanel.webview.postMessage({
            type: 'load',
            fileName,
            content: Array.from(bytes),
          });
          break;
        }

        case 'csvData': {
          document.updateContent(new Uint8Array(message.content));
          break;
        }

        case 'saveTable': {
          const content = new Uint8Array(message.content);
          document.updateContent(content);
          await vscode.workspace.fs.writeFile(document.uri, content);
          break;
        }

        case 'saveTableAs': {
          const content = new Uint8Array(message.content);
          const baseName = (message.fileName as string).replace(/\.[^.]+$/, '');
          const ext = (message.fileExtension as string) || '.csv';
          const defaultUri = vscode.Uri.joinPath(
            vscode.Uri.file(document.uri.fsPath).with({ path: document.uri.fsPath.replace(/[^/]+$/, '') }),
            `${baseName}${ext}`
          );
          const dest = await vscode.window.showSaveDialog({
            defaultUri,
            filters: {
              'CSV Files': ['csv'],
              'TSV Files': ['tsv'],
              'Text Files': ['txt'],
              'All Files': ['*'],
            },
          });
          if (dest) {
            await vscode.workspace.fs.writeFile(dest, content);
            vscode.window.showInformationMessage(`Saved to ${dest.fsPath}`);
          }
          break;
        }
      }
    });
  }

  async saveCustomDocument(
    document: CsvDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    await vscode.workspace.fs.writeFile(document.uri, document.content);
  }

  async saveCustomDocumentAs(
    document: CsvDocument,
    destination: vscode.Uri,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    await vscode.workspace.fs.writeFile(destination, document.content);
  }

  async revertCustomDocument(
    document: CsvDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    const content = await vscode.workspace.fs.readFile(document.uri);
    document.updateContent(content);
  }

  async backupCustomDocument(
    document: CsvDocument,
    context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    await this.saveCustomDocumentAs(document, context.destination, _cancellation);
    return {
      id: context.destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(context.destination);
        } catch {
          // ignore
        }
      },
    };
  }
}
