import * as vscode from 'vscode';
import { getNonce } from '../utils/formatters';
import type { ConnectionManager } from '../services/ConnectionManager';
import { AthenaClientService } from '../services/AthenaClientService';
import type { ConnectionConfig, ConnectionSecrets } from '../models/types';
import * as crypto from 'crypto';

export class ConnectionFormPanel {
    private static _instance: ConnectionFormPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    public static async createOrShow(
        extensionUri: vscode.Uri,
        connectionManager: ConnectionManager,
        athenaService: AthenaClientService,
        editConnection?: ConnectionConfig
    ) {
        if (ConnectionFormPanel._instance) {
            ConnectionFormPanel._instance._panel.reveal(vscode.ViewColumn.One);
            if (editConnection) {
                const secrets = await connectionManager.getSecrets(editConnection.id);
                ConnectionFormPanel._instance._panel.webview.postMessage({
                    command: 'loadConnection',
                    payload: editConnection,
                    secrets
                });
            }
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'athena.connectionForm',
            'Athena Connection',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        ConnectionFormPanel._instance = new ConnectionFormPanel(panel, extensionUri, connectionManager, athenaService);

        if (editConnection) {
            setTimeout(async () => {
                const secrets = await connectionManager.getSecrets(editConnection.id);
                panel.webview.postMessage({
                    command: 'loadConnection',
                    payload: editConnection,
                    secrets
                });
            }, 500);
        }
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        connectionManager: ConnectionManager,
        athenaService: AthenaClientService
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'testConnection': {
                        const tempService = new AthenaClientService();
                        try {
                            const config = message.payload as ConnectionConfig;
                            const secrets = message.payload as ConnectionSecrets;
                            await tempService.setConnection(config, secrets);
                            const result = await tempService.testConnection();
                            this._panel.webview.postMessage({
                                command: 'testResult',
                                success: result.success,
                                message: result.message
                            });
                        } catch (err: any) {
                            this._panel.webview.postMessage({
                                command: 'testResult',
                                success: false,
                                message: err.message
                            });
                        } finally {
                            tempService.dispose();
                        }
                        break;
                    }
                    case 'saveConnection': {
                        try {
                            const config = message.payload as ConnectionConfig;
                            config.name = (config.name || '').trim();
                            if (!config.name) {
                                this._panel.webview.postMessage({
                                    command: 'saveResult',
                                    success: false,
                                    message: 'Connection Name is mandatory.'
                                });
                                break;
                            }
                            const existingConns = connectionManager.getConnections();
                            const isDuplicate = existingConns.some(c => c.name.toLowerCase() === config.name.toLowerCase() && c.id !== config.id);
                            if (isDuplicate) {
                                this._panel.webview.postMessage({
                                    command: 'saveResult',
                                    success: false,
                                    message: `Connection Name '${config.name}' is already in use. Please choose a unique name.`
                                });
                                break;
                            }
                            if (!config.id) {
                                config.id = crypto.randomUUID();
                            }
                            const secrets = message.payload as ConnectionSecrets;
                            await connectionManager.saveConnection(config, secrets);
                            this._panel.webview.postMessage({
                                command: 'saveResult',
                                success: true
                            });
                            vscode.window.showInformationMessage(`Connection '${config.name}' saved successfully.`);
                            this.dispose();
                        } catch (err: any) {
                            this._panel.webview.postMessage({
                                command: 'saveResult',
                                success: false,
                                message: err.message
                            });
                        }
                        break;
                    }
                    case 'openBrowser': {
                        try {
                            if (message.url) {
                                await vscode.env.openExternal(vscode.Uri.parse(message.url));
                                vscode.window.showInformationMessage(`Opening browser for SSO authentication: ${message.url}`);
                            }
                        } catch (e: any) {
                            vscode.window.showErrorMessage(`Failed to open browser: ${e.message}`);
                        }
                        break;
                    }
                    case 'cancel':
                        this.dispose();
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        ConnectionFormPanel._instance = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Athena Connection</title>
    <style>
        body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; }
        input, select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 8px 12px; width: 100%; box-sizing: border-box; }
        label { display: block; margin-bottom: 4px; font-weight: 600; color: var(--vscode-foreground); }
        button { border: 1px solid var(--vscode-button-border, transparent); padding: 6px 12px; border-radius: 2px; cursor: pointer; }
        .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
        .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .form-group { margin-bottom: 16px; }
        .banner { padding: 10px 16px; border-radius: 4px; margin-bottom: 16px; display: none; }
        .banner.success { background: var(--vscode-testing-iconPassed); color: #fff; display: block; }
        .banner.error { background: var(--vscode-testing-iconFailed); color: #fff; display: block; }
        .hidden { display: none; }
        h2 { margin-top: 0; }
        .form-footer { display: flex; gap: 8px; margin-top: 24px; }
    </style>
</head>
<body>
    <h2>Athena Connection</h2>
    <div id="banner" class="banner"></div>

    <form id="connForm">
        <input type="hidden" id="connId" />
        <div class="form-group">
            <label>Connection Name *</label>
            <input type="text" id="connectionName" required />
        </div>
        <div class="form-group">
            <label>Authentication Method</label>
            <select id="authMethod">
                <option value="default">Default Credential Chain</option>
                <option value="profile">AWS Profile</option>
                <option value="accessKeys">Access Key ID & Secret Key</option>
                <option value="sso">Browser SSO / SAML</option>
            </select>
        </div>
        
        <div id="groupProfile" class="form-group hidden">
            <label>Profile Name</label>
            <input type="text" id="profileName" />
        </div>
        
        <div id="groupAccessKeys" class="hidden">
            <div class="form-group">
                <label>Access Key ID</label>
                <input type="text" id="accessKeyId" />
            </div>
            <div class="form-group">
                <label>Secret Access Key</label>
                <input type="password" id="secretAccessKey" />
            </div>
        </div>

        <div id="groupSso" class="hidden">
            <div class="form-group">
                <label>SAML Identity Provider URL *</label>
                <div style="display: flex; gap: 8px;">
                    <input type="text" id="ssoStartUrl" placeholder="https://..." style="flex: 1;" />
                    <button type="button" id="btnOpenBrowser" class="btn-secondary" style="white-space: nowrap;">Open in Browser</button>
                </div>
                <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px;">
                    Opens login in your system's default browser (macOS/Windows). No extra tools required.
                </div>
            </div>
            <div class="form-group">
                <label>SSO Region</label>
                <input type="text" id="ssoRegion" placeholder="e.g. us-east-1" />
            </div>
            <div class="form-group">
                <label>SSO Account ID</label>
                <input type="text" id="ssoAccountId" placeholder="12-digit AWS Account ID" />
            </div>
            <div class="form-group">
                <label>SSO Role Name</label>
                <input type="text" id="ssoRoleName" placeholder="e.g. AthenaUserRole" />
            </div>
        </div>

        <div class="form-group">
            <label>Region *</label>
            <input type="text" id="region" value="us-east-1" required />
        </div>
        <div class="form-group">
            <label>Workgroup</label>
            <input type="text" id="workgroup" value="primary" />
        </div>
        <div class="form-group">
            <label>Catalog</label>
            <input type="text" id="catalog" value="AwsDataCatalog" />
        </div>
        <div class="form-group">
            <label id="lblOutputLocation">Query Result Location *</label>
            <input type="text" id="outputLocation" placeholder="s3://your-bucket/path/" />
            <div id="helpOutputLocation" style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px;">
                Mandatory when workgroup is empty or 'primary'.
            </div>
        </div>
        <div class="form-group">
            <label>Result Set Encryption</label>
            <select id="encryptionType">
                <option value="NONE">None</option>
                <option value="SSE_S3">SSE_S3</option>
                <option value="SSE_KMS">SSE_KMS</option>
                <option value="CSE_KMS">CSE_KMS</option>
            </select>
        </div>
        
        <div id="groupKms" class="form-group hidden">
            <label>KMS Key ARN *</label>
            <input type="text" id="kmsKeyArn" placeholder="arn:aws:kms:region:account:key/..." />
        </div>

        <div class="form-footer">
            <button type="button" id="btnTest" class="btn-secondary">Test Connection</button>
            <button type="button" id="btnSave" class="btn-primary">Save</button>
            <button type="button" id="btnCancel" class="btn-secondary">Cancel</button>
        </div>
    </form>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        const authSelect = document.getElementById('authMethod');
        const encSelect = document.getElementById('encryptionType');
        const banner = document.getElementById('banner');
        const workgroupInput = document.getElementById('workgroup');
        const lblOutputLocation = document.getElementById('lblOutputLocation');
        const helpOutputLocation = document.getElementById('helpOutputLocation');
        const outputLocationInput = document.getElementById('outputLocation');

        authSelect.addEventListener('change', updateAuthFields);
        encSelect.addEventListener('change', updateEncFields);
        workgroupInput.addEventListener('input', updateWorkgroupValidation);

        function updateAuthFields() {
            const val = authSelect.value;
            document.getElementById('groupProfile').classList.toggle('hidden', val !== 'profile');
            document.getElementById('groupAccessKeys').classList.toggle('hidden', val !== 'accessKeys');
            document.getElementById('groupSso').classList.toggle('hidden', val !== 'sso');
        }

        function updateEncFields() {
            const val = encSelect.value;
            document.getElementById('groupKms').classList.toggle('hidden', val === 'NONE' || val === 'SSE_S3');
        }

        function updateWorkgroupValidation() {
            const wg = (workgroupInput.value || '').trim().toLowerCase();
            const isPrimary = !wg || wg === 'primary';
            if (isPrimary) {
                lblOutputLocation.innerHTML = 'Query Result Location * <span style="color:var(--vscode-errorForeground); font-size:11px;">(Mandatory for primary workgroup)</span>';
                helpOutputLocation.textContent = "S3 bucket URI ('s3://...') is required for the primary workgroup.";
            } else {
                lblOutputLocation.innerHTML = 'Query Result Location <span style="color:var(--vscode-descriptionForeground); font-size:11px;">(Optional for custom workgroup)</span>';
                helpOutputLocation.textContent = "Optional: Athena can use the workgroup's configured output location.";
            }
        }

        function showBanner(msg, isSuccess) {
            banner.textContent = msg;
            banner.className = 'banner ' + (isSuccess ? 'success' : 'error');
        }

        function hideBanner() {
            banner.className = 'banner hidden';
        }

        function gatherFormData() {
            return {
                id: document.getElementById('connId').value,
                name: document.getElementById('connectionName').value,
                authMethod: authSelect.value,
                region: document.getElementById('region').value,
                workgroup: document.getElementById('workgroup').value,
                catalog: document.getElementById('catalog').value,
                outputLocation: document.getElementById('outputLocation').value,
                encryptionType: encSelect.value,
                kmsKeyArn: document.getElementById('kmsKeyArn').value,
                profileName: document.getElementById('profileName').value,
                accessKeyId: document.getElementById('accessKeyId').value,
                secretAccessKey: document.getElementById('secretAccessKey').value,
                ssoStartUrl: document.getElementById('ssoStartUrl').value,
                ssoRegion: document.getElementById('ssoRegion').value,
                ssoAccountId: document.getElementById('ssoAccountId').value,
                ssoRoleName: document.getElementById('ssoRoleName').value
            };
        }

        function validateForm(data) {
            if (!data.name || !data.name.trim()) {
                showBanner('Connection Name is mandatory.', false);
                return false;
            }
            if (!data.region || !data.region.trim()) {
                showBanner('AWS Region is mandatory.', false);
                return false;
            }
            if (data.authMethod === 'sso' && (!data.ssoStartUrl || !data.ssoStartUrl.trim())) {
                showBanner('SAML Identity Provider URL is mandatory for Browser SSO.', false);
                return false;
            }
            if (data.authMethod === 'accessKeys' && (!data.accessKeyId || !data.secretAccessKey)) {
                showBanner('Both Access Key ID and Secret Access Key are required.', false);
                return false;
            }
            if (data.authMethod === 'profile' && (!data.profileName || !data.profileName.trim())) {
                showBanner('AWS Profile Name is required.', false);
                return false;
            }
            const wg = (data.workgroup || '').trim().toLowerCase();
            const isPrimary = !wg || wg === 'primary';
            if (isPrimary) {
                if (!data.outputLocation || !data.outputLocation.trim().startsWith('s3://')) {
                    showBanner('Query Result Location is mandatory for primary workgroup and must start with s3://', false);
                    return false;
                }
            } else if (data.outputLocation && !data.outputLocation.trim().startsWith('s3://')) {
                showBanner('Query Result Location must be a valid S3 URI starting with s3://', false);
                return false;
            }
            if ((data.encryptionType === 'SSE_KMS' || data.encryptionType === 'CSE_KMS') && !data.kmsKeyArn) {
                showBanner('KMS Key ARN is required for KMS encryption.', false);
                return false;
            }
            return true;
        }

        document.getElementById('btnOpenBrowser').addEventListener('click', () => {
            const url = document.getElementById('ssoStartUrl').value.trim();
            if (!url) {
                showBanner('Please enter a SAML Identity Provider URL first.', false);
                return;
            }
            vscode.postMessage({ command: 'openBrowser', url });
        });

        document.getElementById('btnTest').addEventListener('click', () => {
            const data = gatherFormData();
            if (!validateForm(data)) {
                return;
            }
            hideBanner();
            document.getElementById('btnTest').textContent = 'Testing...';
            document.getElementById('btnTest').disabled = true;
            vscode.postMessage({ command: 'testConnection', payload: data });
        });

        document.getElementById('btnSave').addEventListener('click', () => {
            const data = gatherFormData();
            if (!validateForm(data)) {
                return;
            }
            vscode.postMessage({ command: 'saveConnection', payload: data });
        });

        document.getElementById('btnCancel').addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'testResult':
                    document.getElementById('btnTest').textContent = 'Test Connection';
                    document.getElementById('btnTest').disabled = false;
                    showBanner(message.message, message.success);
                    break;
                case 'saveResult':
                    if (!message.success) {
                        showBanner(message.message, false);
                    }
                    break;
                case 'loadConnection':
                    const config = message.payload;
                    const secrets = message.secrets || {};
                    document.getElementById('connId').value = config.id || '';
                    document.getElementById('connectionName').value = config.name || '';
                    authSelect.value = config.authMethod || 'default';
                    document.getElementById('region').value = config.region || 'us-east-1';
                    document.getElementById('workgroup').value = config.workgroup || 'primary';
                    document.getElementById('catalog').value = config.catalog || 'AwsDataCatalog';
                    document.getElementById('outputLocation').value = config.outputLocation || '';
                    encSelect.value = config.encryptionType || 'NONE';
                    document.getElementById('kmsKeyArn').value = config.kmsKeyArn || '';
                    document.getElementById('profileName').value = config.profileName || '';
                    document.getElementById('ssoStartUrl').value = config.ssoStartUrl || '';
                    document.getElementById('ssoRegion').value = config.ssoRegion || '';
                    document.getElementById('ssoAccountId').value = config.ssoAccountId || '';
                    document.getElementById('ssoRoleName').value = config.ssoRoleName || '';
                    
                    document.getElementById('accessKeyId').value = secrets.accessKeyId || '';
                    document.getElementById('secretAccessKey').value = secrets.secretAccessKey || '';
                    
                    updateAuthFields();
                    updateEncFields();
                    updateWorkgroupValidation();
                    break;
            }
        });

        updateAuthFields();
        updateEncFields();
        updateWorkgroupValidation();
    </script>
</body>
</html>`;
    }
}
