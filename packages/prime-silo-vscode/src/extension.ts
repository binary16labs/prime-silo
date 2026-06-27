import * as vscode from 'vscode';
import { GraphWebview } from './panels/GraphWebview';

export function activate(context: vscode.ExtensionContext) {
  console.log('Prime-Silo extension is now active!');

  const setupRepoCommand = vscode.commands.registerCommand('prime-silo.setupRepo', () => {
    vscode.window.showInformationMessage('Initializing Prime-Silo Workspace...');
    // Logic to invoke prime-silo CLI / agent skills to scaffold the repo
  });

  const showGraphCommand = vscode.commands.registerCommand('prime-silo.showGraph', () => {
    GraphWebview.render(context.extensionUri);
  });

  context.subscriptions.push(setupRepoCommand, showGraphCommand);
}

export function deactivate() {}
