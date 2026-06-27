import * as vscode from 'vscode';

export class GraphWebview {
  public static currentPanel: GraphWebview | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._panel.onDidDispose(this.dispose, null, this._disposables);
    this._panel.webview.html = this._getWebviewContent(this._panel.webview, extensionUri);
  }

  public static render(extensionUri: vscode.Uri) {
    if (GraphWebview.currentPanel) {
      GraphWebview.currentPanel._panel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel(
        'primeSiloGraph',
        'Prime-Silo Memory Graph',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
        }
      );

      GraphWebview.currentPanel = new GraphWebview(panel, extensionUri);
    }
  }

  public dispose() {
    GraphWebview.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    // In a real implementation, this would load the compiled Three.js bundle
    // from prime-silo's app/L0/_all/mod/_prime_silo/widgets/three_renderer
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Prime-Silo Graph</title>
  <style>
    body, html { margin: 0; padding: 0; height: 100%; overflow: hidden; background-color: #1e1e1e; color: #fff; }
    #root { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-family: sans-serif; }
  </style>
</head>
<body>
  <div id="root">
    <h2>Prime-Silo Three.js Graph Renderer</h2>
    <p>Waiting for Neo4j connection...</p>
  </div>
  <script>
    // Placeholder for Three.js injection
    console.log('Webview loaded');
  </script>
</body>
</html>`;
  }
}
