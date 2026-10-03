import * as vscode from 'vscode';

/**
 * Shared output channel for diagnostics the user needs to be able to read.
 *
 * The browser SAML flow in particular depends on events that happen outside the
 * editor (browser launch, navigation failures, role selection, STS calls), so
 * those steps are written here instead of only to the debug console.
 */
let channel: vscode.OutputChannel | undefined;

export function getLogChannel(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel('AWS Athena SQL Client');
    }
    return channel;
}

export function logLine(message: string): void {
    const stamp = new Date().toISOString().substring(11, 23);
    getLogChannel().appendLine(`[${stamp}] ${message}`);
}

/**
 * Shows an error with a button that reveals the log, so a failure in the
 * browser flow can be traced without re-running it under a debugger.
 */
export async function showErrorWithLog(message: string): Promise<void> {
    logLine(`ERROR: ${message}`);
    const choice = await vscode.window.showErrorMessage(message, 'Show Log');
    if (choice === 'Show Log') {
        getLogChannel().show(true);
    }
}
