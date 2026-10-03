import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;

/**
 * Returns (and lazily creates) the shared "AWS Athena SQL Client" output channel.
 */
export function getOutputChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('AWS Athena SQL Client');
  }
  return _channel;
}

/**
 * Appends a timestamped line to the output channel.
 */
export function logToChannel(message: string): void {
  const ts = new Date().toISOString().substring(11, 23);
  getOutputChannel().appendLine(`[${ts}] ${message}`);
}

/**
 * Logs an error to the channel and shows an error notification with a "Show Log" button.
 */
export async function showErrorWithLog(message: string): Promise<void> {
  logToChannel(`ERROR: ${message}`);
  const action = await vscode.window.showErrorMessage(message, 'Show Log');
  if (action === 'Show Log') {
    getOutputChannel().show(true);
  }
}
