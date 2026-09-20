import * as vscode from 'vscode';
import { ConnectionManager } from './services/ConnectionManager';
import { AthenaClientService } from './services/AthenaClientService';
import { ConnectionsTreeProvider } from './providers/ConnectionsTreeProvider';
import { CatalogTreeProvider } from './providers/CatalogTreeProvider';
import { QueryHistoryTreeProvider } from './providers/QueryHistoryTreeProvider';
import { SavedQueriesTreeProvider } from './providers/SavedQueriesTreeProvider';
import { SqlCodeLensProvider } from './providers/SqlCodeLensProvider';
import { ConnectionFormPanel } from './panels/ConnectionFormPanel';
import { runQuery } from './commands/runQuery';
import { cancelQuery } from './commands/cancelQuery';
import { previewTable, showTableDdl } from './commands/tableActions';
import * as constants from './utils/constants';
import type { ConnectionTreeItem } from './providers/ConnectionsTreeProvider';
import type { CatalogTreeItem } from './providers/CatalogTreeProvider';
import type { SavedQueryTreeItem } from './providers/SavedQueriesTreeProvider';
import type { HistoryTreeItem } from './providers/QueryHistoryTreeProvider';
import type { SavedQuery, QueryHistoryEntry } from './models/types';

export function activate(context: vscode.ExtensionContext) {
    const connectionManager = new ConnectionManager(context);
    const athenaService = new AthenaClientService();

    const connectionsProvider = new ConnectionsTreeProvider(connectionManager, context.extensionUri);
    const catalogProvider = new CatalogTreeProvider(connectionManager, athenaService, context.extensionUri);
    const historyProvider = new QueryHistoryTreeProvider(context, context.extensionUri);
    const savedQueriesProvider = new SavedQueriesTreeProvider(context);
    const codeLensProvider = new SqlCodeLensProvider();

    vscode.window.registerTreeDataProvider(constants.VIEW_CONNECTIONS, connectionsProvider);
    vscode.window.registerTreeDataProvider(constants.VIEW_EXPLORER, catalogProvider);
    vscode.window.registerTreeDataProvider(constants.VIEW_HISTORY, historyProvider);
    vscode.window.registerTreeDataProvider(constants.VIEW_SAVED_QUERIES, savedQueriesProvider);

    vscode.languages.registerCodeLensProvider({ language: 'sql' }, codeLensProvider);

    context.subscriptions.push(
        // ─── Connection Commands ──────────────────────────────────────────
        vscode.commands.registerCommand(constants.CMD_ADD_CONNECTION, () => {
            ConnectionFormPanel.createOrShow(context.extensionUri, connectionManager, athenaService);
        }),
        vscode.commands.registerCommand(constants.CMD_EDIT_CONNECTION, (item: ConnectionTreeItem) => {
            ConnectionFormPanel.createOrShow(context.extensionUri, connectionManager, athenaService, item.config);
        }),
        vscode.commands.registerCommand(constants.CMD_DELETE_CONNECTION, async (item: ConnectionTreeItem) => {
            const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete connection '${item.config.name}'?`, 'Yes', 'No');
            if (confirm === 'Yes') {
                await connectionManager.deleteConnection(item.config.id);
            }
        }),
        vscode.commands.registerCommand(constants.CMD_DUPLICATE_CONNECTION, async (item: ConnectionTreeItem) => {
            await connectionManager.duplicateConnection(item.config.id);
        }),
        vscode.commands.registerCommand(constants.CMD_CONNECT, async (item: ConnectionTreeItem) => {
            try {
                const secrets = await connectionManager.getSecrets(item.config.id);
                await athenaService.setConnection(item.config, secrets);
                await connectionManager.setActiveConnection(item.config.id);
                connectionsProvider.refresh();
                catalogProvider.refresh();
                vscode.window.showInformationMessage(`Connected to ${item.config.name}`);
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to connect: ${error.message}`);
            }
        }),
        vscode.commands.registerCommand(constants.CMD_DISCONNECT, () => {
            athenaService.dispose();
            connectionManager.clearActiveConnection();
            connectionsProvider.refresh();
            catalogProvider.refresh();
            vscode.window.showInformationMessage('Disconnected');
        }),

        // ─── Refresh / Clear Commands ─────────────────────────────────────
        vscode.commands.registerCommand(constants.CMD_REFRESH_CONNECTIONS, () => connectionsProvider.refresh()),
        vscode.commands.registerCommand(constants.CMD_REFRESH_EXPLORER, () => catalogProvider.refresh()),
        vscode.commands.registerCommand(constants.CMD_REFRESH_HISTORY, () => historyProvider.refresh()),
        vscode.commands.registerCommand(constants.CMD_CLEAR_HISTORY, async () => {
            const confirm = await vscode.window.showWarningMessage('Are you sure you want to clear your query history?', 'Yes', 'No');
            if (confirm === 'Yes') {
                historyProvider.clear();
                vscode.window.showInformationMessage('Query history cleared.');
            }
        }),
        vscode.commands.registerCommand(constants.CMD_REFRESH_SAVED_QUERIES, () => savedQueriesProvider.refresh()),

        // ─── Query Execution ──────────────────────────────────────────────
        vscode.commands.registerCommand(constants.CMD_RUN_QUERY, (statementRange?: vscode.Range) =>
            runQuery(athenaService, connectionManager, historyProvider, context.extensionUri, statementRange)
        ),
        vscode.commands.registerCommand(constants.CMD_CANCEL_QUERY, () => cancelQuery(athenaService)),
        vscode.commands.registerCommand(constants.CMD_PREVIEW_TABLE, (item: CatalogTreeItem) =>
            previewTable(athenaService, connectionManager, historyProvider, context.extensionUri, item)
        ),
        vscode.commands.registerCommand(constants.CMD_SHOW_TABLE_DDL, (item: CatalogTreeItem) =>
            showTableDdl(athenaService, connectionManager, historyProvider, context.extensionUri, item)
        ),

        // ─── Saved Queries Commands ───────────────────────────────────────
        vscode.commands.registerCommand(constants.CMD_SAVE_QUERY, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active text editor found.');
                return;
            }
            const selection = editor.selection;
            const sql = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
            
            if (!sql.trim()) {
                vscode.window.showErrorMessage('No query to save.');
                return;
            }

            const name = await vscode.window.showInputBox({
                prompt: 'Enter a name for the saved query',
                placeHolder: 'e.g. user_analytics'
            });
            if (!name) return;

            const saved = await savedQueriesProvider.saveQuery(name, sql);
            vscode.window.showInformationMessage(`Query '${saved.name}' saved to file.`);
        }),
        vscode.commands.registerCommand(constants.CMD_OPEN_SAVED_QUERIES_FOLDER, () => {
            vscode.commands.executeCommand('revealFileInOS', savedQueriesProvider.storageUri);
        }),
        vscode.commands.registerCommand(constants.CMD_DELETE_SAVED_QUERY, async (item: SavedQueryTreeItem) => {
            const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete saved query '${item.query.name}'?`, 'Yes', 'No');
            if (confirm === 'Yes') {
                await savedQueriesProvider.deleteSavedQuery(item.query.namedQueryId);
                vscode.window.showInformationMessage('Saved query deleted.');
            }
        }),
        vscode.commands.registerCommand(constants.CMD_OPEN_SAVED_QUERY, async (query: SavedQuery | SavedQueryTreeItem) => {
            const q = 'query' in query ? query.query : query;
            let doc: vscode.TextDocument;
            if (q.filePath) {
                try {
                    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(q.filePath));
                } catch {
                    doc = await vscode.workspace.openTextDocument({ content: q.queryString, language: 'sql' });
                }
            } else {
                doc = await vscode.workspace.openTextDocument({ content: q.queryString, language: 'sql' });
            }
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
        }),
        vscode.commands.registerCommand(constants.CMD_OPEN_HISTORY_QUERY, async (entry: QueryHistoryEntry | HistoryTreeItem) => {
            const q = 'entry' in entry ? entry.entry : entry;
            const doc = await vscode.workspace.openTextDocument({ content: q.query, language: 'sql' });
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
        })
    );

    context.subscriptions.push(connectionManager, athenaService);
}

export function deactivate() {}
