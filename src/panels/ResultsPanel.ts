import * as vscode from 'vscode';
import { getNonce, formatBytes, formatDuration, escapeHtml } from '../utils/formatters';
import type { QueryResult } from '../models/types';
import { RESULT_PAGE_SIZE } from '../utils/constants';

export class ResultsPanel {
    private static _counter = 0;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _result: QueryResult;
    private _disposables: vscode.Disposable[] = [];

    public static async create(extensionUri: vscode.Uri, result: QueryResult): Promise<ResultsPanel> {
        this._counter++;

        try {
            await vscode.commands.executeCommand('workbench.action.editorLayoutTwoRows');
        } catch {
            // Fallback gracefully if command is not available
        }

        const panel = vscode.window.createWebviewPanel(
            'athena.results',
            `Result ${this._counter}`,
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        const resultsPanel = new ResultsPanel(panel, result);
        resultsPanel._init();
        return resultsPanel;
    }

    private constructor(panel: vscode.WebviewPanel, result: QueryResult) {
        this._panel = panel;
        this._result = result;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.onDidChangeViewState(
            e => {
                if (e.webviewPanel.visible) {
                    this._panel.webview.postMessage({
                        command: 'setData',
                        columns: this._result.columns,
                        rows: this._result.rows
                    });
                }
            },
            null,
            this._disposables
        );
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'exportCsv':
                        await this._exportData(message.data, 'csv');
                        return;
                    case 'exportJson':
                        await this._exportData(message.data, 'json');
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    private _init() {
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, this._result);
        this._panel.webview.postMessage({ command: 'setData', columns: this._result.columns, rows: this._result.rows });
    }

    private async _exportData(data: string, type: 'csv' | 'json') {
        const uri = await vscode.window.showSaveDialog({
            filters: type === 'csv' ? { 'CSV files': ['csv'] } : { 'JSON files': ['json'] },
            defaultUri: vscode.Uri.file(`results.${type}`)
        });
        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(data, 'utf8'));
            vscode.window.showInformationMessage(`Results exported to ${uri.fsPath}`);
        }
    }

    public dispose() {
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview, result: QueryResult): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Results</title>
    <style>
        body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; overflow: auto; margin: 0; }
        .metadata-bar { padding: 12px 16px; background: var(--vscode-editor-lineHighlightBackground); border-radius: 4px; margin-bottom: 12px; display: flex; gap: 24px; flex-wrap: wrap; font-size: 12px; }
        .metadata-item { display: flex; gap: 6px; align-items: center; }
        .metadata-label { color: var(--vscode-descriptionForeground); font-weight: 600; }
        .toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
        button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent); padding: 4px 8px; border-radius: 2px; cursor: pointer; font-size: 12px; }
        button:hover { background: var(--vscode-button-secondaryHoverBackground); }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th { background: var(--vscode-editor-lineHighlightBackground); color: var(--vscode-foreground); padding: 8px 12px; text-align: left; border-bottom: 2px solid var(--vscode-panel-border); position: sticky; top: 0; font-weight: 600; }
        td { padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); }
        tr:hover td { background: var(--vscode-list-hoverBackground); }
        .null-val { color: var(--vscode-descriptionForeground); font-style: italic; }
        .pagination { display: flex; gap: 8px; align-items: center; margin-top: 12px; font-size: 12px; }
    </style>
</head>
<body>
    <div class="metadata-bar">
        <div class="metadata-item"><span class="metadata-label">Status:</span> <span>${escapeHtml(result.status)}</span></div>
        <div class="metadata-item"><span class="metadata-label">Duration:</span> <span>${escapeHtml(formatDuration(result.elapsedTimeMs))}</span></div>
        <div class="metadata-item"><span class="metadata-label">Data Scanned:</span> <span>${escapeHtml(formatBytes(result.dataScannedBytes))}</span></div>
        <div class="metadata-item"><span class="metadata-label">Rows:</span> <span>${result.totalRows}</span></div>
        <div class="metadata-item"><span class="metadata-label">Query ID:</span> <span>${escapeHtml(result.queryExecutionId)}</span></div>
    </div>
    
    <div class="toolbar">
        <button id="btnCopyCsv">Copy CSV</button>
        <button id="btnExportCsv">Export CSV</button>
        <button id="btnExportJson">Export JSON</button>
    </div>

    <table id="resultsTable">
        <thead><tr id="theadRow"></tr></thead>
        <tbody id="tbody"></tbody>
    </table>

    <div class="pagination">
        <button id="btnPrev" disabled>Previous</button>
        <span id="pageInfo">Page 1</span>
        <button id="btnNext" disabled>Next</button>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const initialData = ${JSON.stringify({ columns: result.columns, rows: result.rows }).replace(/</g, '\\u003c')};
        const previousState = vscode.getState();
        let columns = (previousState && previousState.columns) ? previousState.columns : (initialData.columns || []);
        let allRows = (previousState && previousState.rows) ? previousState.rows : (initialData.rows || []);
        const pageSize = ${RESULT_PAGE_SIZE};
        let currentPage = (previousState && typeof previousState.currentPage === 'number') ? previousState.currentPage : 0;

        function saveState() {
            vscode.setState({ columns, rows: allRows, currentPage });
        }

        saveState();

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'setData') {
                columns = message.columns || [];
                allRows = message.rows || [];
                saveState();
                renderTable();
            }
        });

        function renderTable() {
            const theadRow = document.getElementById('theadRow');
            theadRow.innerHTML = '';
            for (const col of columns) {
                const th = document.createElement('th');
                th.textContent = col.name;
                theadRow.appendChild(th);
            }

            const tbody = document.getElementById('tbody');
            tbody.innerHTML = '';
            
            const start = currentPage * pageSize;
            const end = Math.min(start + pageSize, allRows.length);
            const slice = allRows.slice(start, end);

            for (const row of slice) {
                const tr = document.createElement('tr');
                for (const val of row) {
                    const td = document.createElement('td');
                    if (val === null || val === undefined || val === '') {
                        td.innerHTML = '<span class="null-val">NULL</span>';
                    } else {
                        td.textContent = val;
                    }
                    tr.appendChild(td);
                }
                tbody.appendChild(tr);
            }

            const totalPages = Math.max(1, Math.ceil(allRows.length / pageSize));
            document.getElementById('pageInfo').textContent = 'Page ' + (currentPage + 1) + ' of ' + totalPages;
            document.getElementById('btnPrev').disabled = currentPage === 0;
            document.getElementById('btnNext').disabled = end >= allRows.length;
        }

        document.getElementById('btnPrev').addEventListener('click', () => {
            if (currentPage > 0) {
                currentPage--;
                saveState();
                renderTable();
            }
        });

        document.getElementById('btnNext').addEventListener('click', () => {
            if ((currentPage + 1) * pageSize < allRows.length) {
                currentPage++;
                saveState();
                renderTable();
            }
        });

        // Initial render on load
        renderTable();

        function generateCsv() {
            const header = columns.map(c => '"' + c.name.replace(/"/g, '""') + '"').join(',');
            const rows = allRows.map(row => row.map(val => {
                if (val === null || val === undefined) return '';
                return '"' + String(val).replace(/"/g, '""') + '"';
            }).join(','));
            return [header, ...rows].join('\\n');
        }

        document.getElementById('btnCopyCsv').addEventListener('click', () => {
            const csv = generateCsv();
            navigator.clipboard.writeText(csv);
        });

        document.getElementById('btnExportCsv').addEventListener('click', () => {
            vscode.postMessage({ command: 'exportCsv', data: generateCsv() });
        });

        document.getElementById('btnExportJson').addEventListener('click', () => {
            const jsonData = allRows.map(row => {
                const obj = {};
                columns.forEach((col, i) => {
                    obj[col.name] = row[i];
                });
                return obj;
            });
            vscode.postMessage({ command: 'exportJson', data: JSON.stringify(jsonData, null, 2) });
        });
    </script>
</body>
</html>`;
    }
}
