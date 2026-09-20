import * as vscode from 'vscode';
import * as path from 'path';
import type { QueryHistoryEntry } from '../models/types';
import { STORAGE_HISTORY, CMD_OPEN_HISTORY_QUERY } from '../utils/constants';
import { formatBytes, formatDuration, truncateQuery } from '../utils/formatters';

export class HistoryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: QueryHistoryEntry,
    extensionUri: vscode.Uri
  ) {
    super(truncateQuery(entry.query, 60), vscode.TreeItemCollapsibleState.None);
    this.description = `${formatDuration(entry.elapsedTimeMs)} | ${formatBytes(entry.dataScannedBytes)}`;
    
    const tooltip = new vscode.MarkdownString();
    tooltip.appendCodeblock(entry.query, 'sql');
    tooltip.appendMarkdown(`\n\n**Status**: ${entry.status}`);
    if (entry.elapsedTimeMs !== undefined) {
      tooltip.appendMarkdown(`\n\n**Time**: ${formatDuration(entry.elapsedTimeMs)}`);
    }
    if (entry.dataScannedBytes !== undefined) {
      tooltip.appendMarkdown(`\n\n**Scanned**: ${formatBytes(entry.dataScannedBytes)}`);
    }
    if (entry.errorMessage) {
      tooltip.appendMarkdown(`\n\n**Error**: ${entry.errorMessage}`);
    }
    this.tooltip = tooltip;
    this.contextValue = 'historyItem';
    
    let iconName = '';
    switch (entry.status) {
      case 'SUCCEEDED': iconName = 'query-succeeded.svg'; break;
      case 'FAILED': iconName = 'query-failed.svg'; break;
      case 'RUNNING':
      case 'QUEUED': iconName = 'query-running.svg'; break;
      case 'CANCELLED': iconName = 'query-cancelled.svg'; break;
    }
    
    if (iconName) {
      this.iconPath = {
        light: vscode.Uri.file(path.join(extensionUri.fsPath, 'media', 'light', iconName)),
        dark: vscode.Uri.file(path.join(extensionUri.fsPath, 'media', 'dark', iconName))
      };
    }
    
    this.command = {
      command: CMD_OPEN_HISTORY_QUERY,
      title: 'Open Query',
      arguments: [entry]
    };
  }
}

export class QueryHistoryTreeProvider implements vscode.TreeDataProvider<HistoryTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<HistoryTreeItem | undefined | null | void> = new vscode.EventEmitter<HistoryTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<HistoryTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private _entries: QueryHistoryEntry[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri
  ) {
    this._loadEntries();
  }

  private _loadEntries(): void {
    const raw = this.context.globalState.get<any[]>(STORAGE_HISTORY, []);
    this._entries = raw.map(e => ({
      ...e,
      submissionTime: e.submissionTime ? new Date(e.submissionTime) : undefined,
      completionTime: e.completionTime ? new Date(e.completionTime) : undefined
    }));
  }

  private _persist(): void {
    this.context.globalState.update(STORAGE_HISTORY, this._entries);
  }

  public refresh(): void {
    this._loadEntries();
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: HistoryTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: HistoryTreeItem): vscode.ProviderResult<HistoryTreeItem[]> {
    if (element) {
      return [];
    }
    return this._entries.map(e => new HistoryTreeItem(e, this.extensionUri));
  }

  public addEntry(entry: QueryHistoryEntry): void {
    this._entries.unshift(entry);
    if (this._entries.length > 100) {
      this._entries = this._entries.slice(0, 100);
    }
    this._persist();
    this._onDidChangeTreeData.fire();
  }

  public clear(): void {
    this._entries = [];
    this._persist();
    this._onDidChangeTreeData.fire();
  }
}
