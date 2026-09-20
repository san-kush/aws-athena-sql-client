import * as vscode from 'vscode';
import type { AthenaClientService } from '../services/AthenaClientService';
import { getCurrentQueryId } from './runQuery';

export async function cancelQuery(athenaService: AthenaClientService, queryExecutionId?: string): Promise<void> {
  const id = queryExecutionId || getCurrentQueryId() || (athenaService as any)._currentQueryExecutionId;
  if (!id) {
    vscode.window.showInformationMessage('No Athena query is currently running.');
    return;
  }
  try {
    await athenaService.cancelQuery(id);
    vscode.window.showInformationMessage('Athena query cancelled.');
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to cancel query: ${err.message}`);
  }
}
