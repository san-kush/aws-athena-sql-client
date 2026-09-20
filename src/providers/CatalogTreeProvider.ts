import * as vscode from 'vscode';
import * as path from 'path';
import type { CatalogNodeInfo } from '../models/types';
import type { ConnectionManager } from '../services/ConnectionManager';
import type { AthenaClientService } from '../services/AthenaClientService';

export class CatalogTreeItem extends vscode.TreeItem {
  constructor(
    public readonly info: CatalogNodeInfo,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    extensionUri: vscode.Uri
  ) {
    super(info.name, collapsibleState);
    if (info.type === 'column') {
      this.description = info.dataType + (info.isPartitionKey ? ' (partition key)' : '');
    }
    this.contextValue = info.type;
    
    let iconName = '';
    switch (info.type) {
      case 'catalog': iconName = 'database.svg'; break;
      case 'database': iconName = 'database.svg'; break;
      case 'table': iconName = 'table.svg'; break;
      case 'view': iconName = 'view.svg'; break;
      case 'column': iconName = 'column.svg'; break;
    }
    
    if (iconName) {
      this.iconPath = {
        light: vscode.Uri.file(path.join(extensionUri.fsPath, 'media', 'light', iconName)),
        dark: vscode.Uri.file(path.join(extensionUri.fsPath, 'media', 'dark', iconName))
      };
    }
  }
}

export class CatalogTreeProvider implements vscode.TreeDataProvider<CatalogTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<CatalogTreeItem | undefined | null | void> = new vscode.EventEmitter<CatalogTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<CatalogTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly athenaService: AthenaClientService,
    private readonly extensionUri: vscode.Uri
  ) {
    this.connectionManager.onDidChangeActiveConnection(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CatalogTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: CatalogTreeItem): Promise<CatalogTreeItem[]> {
    if (!this.connectionManager.getActiveConnection()) {
      return [];
    }

    try {
      if (!element) {
        const catalogs = await this.athenaService.getCatalogs();
        return catalogs.map(name => new CatalogTreeItem(
          { type: 'catalog', name },
          vscode.TreeItemCollapsibleState.Collapsed,
          this.extensionUri
        ));
      }

      const { info } = element;

      if (info.type === 'catalog') {
        const databases = await this.athenaService.getDatabases(info.name);
        return databases.map(name => new CatalogTreeItem(
          { type: 'database', name, catalogName: info.name },
          vscode.TreeItemCollapsibleState.Collapsed,
          this.extensionUri
        ));
      }

      if (info.type === 'database') {
        const tables = await this.athenaService.getTables(info.catalogName!, info.name);
        return tables.map(table => new CatalogTreeItem(
          { type: table.type, name: table.name, catalogName: info.catalogName, databaseName: info.name },
          vscode.TreeItemCollapsibleState.Collapsed,
          this.extensionUri
        ));
      }

      if (info.type === 'table' || info.type === 'view') {
        const columns = await this.athenaService.getColumns(info.catalogName!, info.databaseName!, info.name);
        return columns.map(col => new CatalogTreeItem(
          { type: 'column', name: col.name, dataType: col.type, isPartitionKey: false, catalogName: info.catalogName, databaseName: info.databaseName, tableName: info.name }, // Assuming false if not known, or mapped from API if available
          vscode.TreeItemCollapsibleState.None,
          this.extensionUri
        ));
      }

      return [];
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to load catalog data: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
}
