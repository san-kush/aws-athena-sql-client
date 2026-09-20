import * as vscode from 'vscode';
import type { AthenaClientService } from '../services/AthenaClientService';
import type { ConnectionManager } from '../services/ConnectionManager';
import type { QueryHistoryTreeProvider } from '../providers/QueryHistoryTreeProvider';
import type { CatalogTreeItem } from '../providers/CatalogTreeProvider';
import { ResultsPanel } from '../panels/ResultsPanel';

export async function previewTable(
    athenaService: AthenaClientService,
    connectionManager: ConnectionManager,
    historyProvider: QueryHistoryTreeProvider,
    extensionUri: vscode.Uri,
    item?: CatalogTreeItem
): Promise<void> {
    const activeConnection = connectionManager.getActiveConnection();
    if (!activeConnection) {
        vscode.window.showErrorMessage('No active Athena connection. Please connect first.');
        return;
    }

    if (!item?.info?.databaseName || !item?.info?.name) {
        vscode.window.showErrorMessage('Please right-click on a table in the Catalog Explorer.');
        return;
    }

    const database = item.info.databaseName;
    const table = item.info.name;
    const sql = `SELECT * FROM "${database}"."${table}" LIMIT 10`;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Previewing ${database}.${table}...`,
        cancellable: true
    }, async (progress, token) => {
        token.onCancellationRequested(async () => {
            const id = (athenaService as any)._currentQueryExecutionId;
            if (id) {
                try {
                    await athenaService.cancelQuery(id);
                    vscode.window.showInformationMessage('Preview query cancelled.');
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to cancel query: ${e.message}`);
                }
            }
        });

        try {
            const result = await athenaService.executeQuery(sql, database, (status) => {
                progress.report({ message: status });
            });

            await ResultsPanel.create(extensionUri, result);

            historyProvider.addEntry({
                queryExecutionId: result.queryExecutionId,
                query: sql,
                status: result.status,
                completionTime: new Date(),
                elapsedTimeMs: result.elapsedTimeMs,
                dataScannedBytes: result.dataScannedBytes,
                database,
                workgroup: activeConnection.workgroup
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Preview failed: ${error.message}`);
            const id = (athenaService as any)._currentQueryExecutionId;
            if (id) {
                historyProvider.addEntry({
                    queryExecutionId: id,
                    query: sql,
                    status: 'FAILED',
                    errorMessage: error.message
                });
            }
        }
    });
}

export async function showTableDdl(
    athenaService: AthenaClientService,
    connectionManager: ConnectionManager,
    historyProvider: QueryHistoryTreeProvider,
    extensionUri: vscode.Uri,
    item?: CatalogTreeItem
): Promise<void> {
    const activeConnection = connectionManager.getActiveConnection();
    if (!activeConnection) {
        vscode.window.showErrorMessage('No active Athena connection. Please connect first.');
        return;
    }

    if (!item?.info?.databaseName || !item?.info?.name) {
        vscode.window.showErrorMessage('Please right-click on a table in the Catalog Explorer.');
        return;
    }

    const database = item.info.databaseName;
    const table = item.info.name;
    const isView = item.info.type === 'view';
    // Athena SHOW CREATE syntax uses unquoted/backtick identifiers
    const sql = isView
        ? `SHOW CREATE VIEW \`${database}\`.\`${table}\``
        : `SHOW CREATE TABLE \`${database}\`.\`${table}\``;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Fetching DDL for ${database}.${table}...`,
        cancellable: true
    }, async (progress, token) => {
        token.onCancellationRequested(async () => {
            const id = (athenaService as any)._currentQueryExecutionId;
            if (id) {
                try {
                    await athenaService.cancelQuery(id);
                    vscode.window.showInformationMessage('Show DDL query cancelled.');
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to cancel query: ${e.message}`);
                }
            }
        });

        let ddlContent: string | undefined;

        try {
            // 1. First attempt: try Athena SHOW CREATE query
            const result = await athenaService.executeQuery(sql, database, (status) => {
                progress.report({ message: status });
            });

            if (result.rows && result.rows.length > 0) {
                ddlContent = result.rows.map(row => row.join('')).join('\n');
            }

            historyProvider.addEntry({
                queryExecutionId: result.queryExecutionId,
                query: sql,
                status: result.status,
                completionTime: new Date(),
                elapsedTimeMs: result.elapsedTimeMs,
                dataScannedBytes: result.dataScannedBytes,
                database,
                workgroup: activeConnection.workgroup
            });
        } catch (athenaErr: any) {
            // 2. Fallback: If Athena doesn't support SHOW CREATE for this table (e.g. Iceberg, external formats),
            // construct the accurate DDL directly from AWS Glue Catalog metadata!
            try {
                ddlContent = await athenaService.getTableDdl(
                    activeConnection.catalog,
                    database,
                    table
                );
            } catch (glueErr: any) {
                vscode.window.showErrorMessage(`Show DDL failed: ${athenaErr.message || glueErr.message}`);
                return;
            }
        }

        if (ddlContent) {
            const doc = await vscode.workspace.openTextDocument({
                content: ddlContent,
                language: 'sql'
            });
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
        } else {
            vscode.window.showWarningMessage(`No DDL returned for ${database}.${table}.`);
        }
    });
}
