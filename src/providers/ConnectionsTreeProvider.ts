import * as vscode from 'vscode';
import * as path from 'path';
import type { ConnectionConfig } from '../models/types';
import type { ConnectionManager } from '../services/ConnectionManager';

export class ConnectionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly config: ConnectionConfig,
    isActive: boolean,
    extensionUri: vscode.Uri
  ) {
    super(config.name, vscode.TreeItemCollapsibleState.None);
    this.description = config.region;
    this.contextValue = isActive ? 'connection-active' : 'connection-inactive';
    this.tooltip = `${config.name} (${config.region}) - ${config.workgroup}`;
    this.iconPath = {
      light: vscode.Uri.file(path.join(extensionUri.fsPath, 'media', 'light', isActive ? 'connection-active.svg' : 'connection-inactive.svg')),
      dark: vscode.Uri.file(path.join(extensionUri.fsPath, 'media', 'dark', isActive ? 'connection-active.svg' : 'connection-inactive.svg'))
    };
  }
}

export class ConnectionsTreeProvider implements vscode.TreeDataProvider<ConnectionTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ConnectionTreeItem | undefined | null | void> = new vscode.EventEmitter<ConnectionTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<ConnectionTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly extensionUri: vscode.Uri
  ) {
    this.connectionManager.onDidChangeConnections(() => this.refresh());
    this.connectionManager.onDidChangeActiveConnection(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ConnectionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ConnectionTreeItem): vscode.ProviderResult<ConnectionTreeItem[]> {
    if (!element) {
      return this.connectionManager.getConnections().map(c => 
        new ConnectionTreeItem(c, this.connectionManager.isConnected(c.id), this.extensionUri)
      );
    }
    return [];
  }
}
