import * as vscode from 'vscode';
import type { AthenaClientService } from '../services/AthenaClientService';
import type { ConnectionManager } from '../services/ConnectionManager';
import type { QueryHistoryTreeProvider } from '../providers/QueryHistoryTreeProvider';
import { ResultsPanel } from '../panels/ResultsPanel';
import type { QueryHistoryEntry } from '../models/types';

let currentQueryId: string | undefined;

export function getCurrentQueryId(): string | undefined {
    return currentQueryId;
}

export async function runQuery(
    athenaService: AthenaClientService,
    connectionManager: ConnectionManager,
    historyProvider: QueryHistoryTreeProvider,
    extensionUri: vscode.Uri,
    statementRange?: vscode.Range
): Promise<void> {
    const activeConnection = connectionManager.getActiveConnection();
    if (!activeConnection) {
        vscode.window.showErrorMessage('No active Athena connection. Please connect first.');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active text editor found.');
        return;
    }

    let sql: string;
    const selection = editor.selection;

    if (!selection.isEmpty) {
        // User explicitly selected text — run that
        sql = editor.document.getText(selection);
    } else if (statementRange) {
        // CodeLens clicked — run only the targeted statement
        sql = editor.document.getText(statementRange);
    } else {
        // Fallback: run entire document (e.g. invoked from command palette)
        sql = editor.document.getText();
    }

    if (!sql.trim()) {
        vscode.window.showErrorMessage('No SQL query found to run.');
        return;
    }

    // Strip trailing semicolons for Athena (it doesn't accept them)
    sql = sql.trim().replace(/;\s*$/, '');

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Running Athena query...',
        cancellable: true
    }, async (progress, token) => {
        token.onCancellationRequested(async () => {
            const id = currentQueryId || (athenaService as any)._currentQueryExecutionId;
            if (id) {
                try {
                    await athenaService.cancelQuery(id);
                    vscode.window.showInformationMessage('Athena query cancelled.');
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to cancel query: ${e.message}`);
                }
            }
        });

        try {
            const result = await athenaService.executeQuery(sql, undefined, (status) => {
                progress.report({ message: status });
            });
            
            if (result.queryExecutionId) {
                currentQueryId = result.queryExecutionId;
            }

            await ResultsPanel.create(extensionUri, result);

            const entry: QueryHistoryEntry = {
                queryExecutionId: result.queryExecutionId,
                query: sql,
                status: result.status,
                completionTime: new Date(),
                elapsedTimeMs: result.elapsedTimeMs,
                dataScannedBytes: result.dataScannedBytes,
                database: activeConnection.catalog,
                workgroup: activeConnection.workgroup
            };
            historyProvider.addEntry(entry);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Query execution failed: ${error.message}`);
            const id = currentQueryId || (athenaService as any)._currentQueryExecutionId;
            if (id) {
                 const failedEntry: QueryHistoryEntry = {
                    queryExecutionId: id,
                    query: sql,
                    status: 'FAILED',
                    errorMessage: error.message
                 };
                 historyProvider.addEntry(failedEntry);
            }
        } finally {
            currentQueryId = undefined;
        }
    });
}
