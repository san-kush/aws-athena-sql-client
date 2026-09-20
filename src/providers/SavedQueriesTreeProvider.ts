import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import type { SavedQuery } from '../models/types';
import { STORAGE_SAVED_QUERIES, CMD_OPEN_SAVED_QUERY } from '../utils/constants';

export class SavedQueryTreeItem extends vscode.TreeItem {
  constructor(public readonly query: SavedQuery) {
    super(query.name, vscode.TreeItemCollapsibleState.None);
    this.description = query.filePath ? path.basename(query.filePath) : '';
    
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**Name**: ${query.name}\n\n`);
    if (query.filePath) {
      tooltip.appendMarkdown(`**File**: ${query.filePath}\n\n`);
    }
    if (query.description) {
      tooltip.appendMarkdown(`**Description**: ${query.description}\n\n`);
    }
    const truncatedQuery = query.queryString.length > 200 ? query.queryString.substring(0, 200) + '...' : query.queryString;
    tooltip.appendCodeblock(truncatedQuery, 'sql');
    
    this.tooltip = tooltip;
    this.contextValue = 'savedQuery';
    this.iconPath = new vscode.ThemeIcon('file-code');
    this.command = {
      command: CMD_OPEN_SAVED_QUERY,
      title: 'Open Query',
      arguments: [query]
    };
  }
}

export class SavedQueriesTreeProvider implements vscode.TreeDataProvider<SavedQueryTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<SavedQueryTreeItem | undefined | null | void> = new vscode.EventEmitter<SavedQueryTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<SavedQueryTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private _queries: SavedQuery[] = [];
  private readonly _storageDir: vscode.Uri;

  constructor(private readonly context: vscode.ExtensionContext) {
    this._storageDir = vscode.Uri.joinPath(context.globalStorageUri, 'saved-queries');
    this._initStorage();
  }

  public get storageUri(): vscode.Uri {
    return this._storageDir;
  }

  private async _initStorage(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this._storageDir);
    } catch {
      // ignore
    }
    this._loadQueries();
    // Ensure all existing queries have backing files
    let modified = false;
    for (const q of this._queries) {
      if (!q.filePath) {
        const safeName = q.name.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'query';
        const fileUri = vscode.Uri.joinPath(this._storageDir, `${safeName}_${q.namedQueryId.slice(0, 8)}.sql`);
        try {
          await vscode.workspace.fs.writeFile(fileUri, Buffer.from(q.queryString, 'utf8'));
          q.filePath = fileUri.fsPath;
          modified = true;
        } catch {
          // ignore
        }
      }
    }
    if (modified) {
      this._persist();
      this._onDidChangeTreeData.fire();
    }
  }

  private _loadQueries(): void {
    this._queries = this.context.globalState.get<SavedQuery[]>(STORAGE_SAVED_QUERIES, []);
  }

  private _persist(): void {
    this.context.globalState.update(STORAGE_SAVED_QUERIES, this._queries);
  }

  public refresh(): void {
    this._loadQueries();
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: SavedQueryTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: SavedQueryTreeItem): vscode.ProviderResult<SavedQueryTreeItem[]> {
    if (element) {
      return [];
    }
    return this._queries.map(q => new SavedQueryTreeItem(q));
  }

  public async saveQuery(name: string, sql: string, description?: string): Promise<SavedQuery> {
    try {
      await vscode.workspace.fs.createDirectory(this._storageDir);
    } catch {
      // ignore
    }

    const sanitizedBase = name.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'query';
    let fileName = `${sanitizedBase}.sql`;
    let fileUri = vscode.Uri.joinPath(this._storageDir, fileName);
    let counter = 1;

    while (this._queries.some(q => q.filePath === fileUri.fsPath)) {
      fileName = `${sanitizedBase}_${counter++}.sql`;
      fileUri = vscode.Uri.joinPath(this._storageDir, fileName);
    }

    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(sql, 'utf8'));

    const query: SavedQuery = {
      namedQueryId: crypto.randomUUID(),
      name,
      description: description || '',
      queryString: sql,
      filePath: fileUri.fsPath
    };

    this._queries.unshift(query);
    this._persist();
    this._onDidChangeTreeData.fire();
    return query;
  }

  public async deleteSavedQuery(namedQueryId: string): Promise<void> {
    const query = this._queries.find(q => q.namedQueryId === namedQueryId);
    if (query?.filePath) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(query.filePath));
      } catch {
        // file might already be removed
      }
    }

    this._queries = this._queries.filter(q => q.namedQueryId !== namedQueryId);
    this._persist();
    this._onDidChangeTreeData.fire();
  }
}
