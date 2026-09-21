# Release Notes

Welcome to the release notes for **AWS Athena SQL Client**. Each release includes detailed notes on new features, improvements, fixes, and direct download links to the version's release artifact (`.vsix`).

---

## Version 0.1.2

**Release Date:** September 21, 2026  
**Artifact Package:** `aws-athena-sql-client-0.1.2.vsix`

### 📦 Download Artifact
- **[Download VSIX Artifact (v0.1.2)](https://github.com/san-kush/aws-athena-sql-client/releases/download/v0.1.2/aws-athena-sql-client-0.1.2.vsix)**
- **File Name:** `aws-athena-sql-client-0.1.2.vsix`
- **Release Tag:** [`v0.1.2`](https://github.com/san-kush/aws-athena-sql-client/releases/tag/v0.1.2)

---

### Highlights & Key Features

#### 1. Interactive Column Header Sorting in Query Results
- **Tri-State Column Sorting**: Click any column header in the query results table to cycle through **Ascending (▲)**, **Descending (▼)**, and **Original order**.
- **Intelligent Type-Aware Comparison**: Automatically handles numbers numerically, natural strings (`localeCompare`), and sorts null/empty values cleanly to the end.
- **Dataset-Wide & Persistent**: Sorting applies across the complete dataset (not just the active page), automatically resets pagination to page 1, persists across tab switching (`retainContextWhenHidden` + `vscode.setState`), and carries through to CSV and JSON exports.

#### 2. Browser Process Launch Reliability Fix (`Code: 0`)
- **Environment Sanitization**: Fully sanitized the execution environment passed to spawned browser instances. Prevents leaked VS Code / Electron variables (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `VSCODE_*`) from corrupting browser child processes.
- **Edge Startup Boost & Singleton Handover Prevention**: Added flags (`--disable-features=msEdgeStartupBoost`, `--disable-background-mode`, `--disable-background-networking`, `--no-sandbox`, `--disable-gpu`) preventing background Microsoft Edge processes from seizing the instance and exiting immediately.
- **Stealth Automation**: Added `ignoreDefaultArgs: ['--enable-automation']` to ensure standard user browser behavior, bypassing enterprise IdP automation blocks.
- **Chrome & Edge Multi-Browser Fallback**: Prioritizes Google Chrome for CDP stability and automatically falls back to Microsoft Edge if needed.

#### 3. Leaner Production Artifact
- Excluded test and scratch scripts from the `.vsix` bundle via `.vscodeignore`.

---

## Version 0.1.1

**Release Date:** September 21, 2026  
**Artifact Package:** `aws-athena-sql-client-0.1.1.vsix`

### 📦 Download Artifact
- **[Download VSIX Artifact (v0.1.1)](https://github.com/san-kush/aws-athena-sql-client/releases/download/v0.1.1/aws-athena-sql-client-0.1.1.vsix)**
- **File Name:** `aws-athena-sql-client-0.1.1.vsix`
- **Release Tag:** [`v0.1.1`](https://github.com/san-kush/aws-athena-sql-client/releases/tag/v0.1.1)

---

### Highlights & Key Features

#### 1. Automated Interactive SAML Browser Login (Edge / Chrome)
- **Zero-Friction Authentication**: Authenticate with enterprise Identity Providers (Okta, Azure AD / Microsoft Entra ID, Ping Identity, Google Workspace, Keycloak) simply by supplying your corporate SAML IdP URL.
- **Automated Browser Automation**: Launches an isolated browser window via your existing system **Microsoft Edge** or **Google Chrome** using lightweight `puppeteer-core` (no bulky Chromium download).
- **Auto-Capture & Auto-Close**: Select your IAM role on the AWS SAML page, and the extension captures the SAML assertion, assumes the IAM role via AWS STS `AssumeRoleWithSAMLCommand`, and **automatically closes the browser window**.
- **Session Expiration Guard**: Automatically detects expired temporary credentials and provides a 1-click re-authentication prompt.

#### 2. DDL & Metadata Corrections
- **Table DDL First Line Preserved**: Fixed an issue where `rawRows[0]` was being skipped, ensuring the initial `CREATE TABLE` / `CREATE EXTERNAL TABLE` line is always included.
- **Presto/Trino View Decoding**: Accurately decodes and formats Presto/Trino view definitions (`/* Presto View: ... */`) stored in AWS Glue Data Catalog into clean `CREATE OR REPLACE VIEW` statements.

#### 3. Persistent Multi-Tab Results
- **Prevent Dataset Vanishing**: Enabled Webview context retention and native VS Code state persistence so query results remain preserved when switching between multiple query tabs.

---

## Version 0.1.0 (Initial Release)

**Release Date:** September 21, 2026  
**Artifact Package:** `aws-athena-sql-client-0.1.0.vsix`

### 📦 Download Artifact
- **[Download VSIX Artifact (v0.1.0)](https://github.com/san-kush/aws-athena-sql-client/releases/download/v0.1.0/aws-athena-sql-client-0.1.0.vsix)**
- **File Name:** `aws-athena-sql-client-0.1.0.vsix`
- **Release Tag:** [`v0.1.0`](https://github.com/san-kush/aws-athena-sql-client/releases/tag/v0.1.0)

---

### Highlights & Key Features

#### 1. Multi-Statement SQL Support & CodeLens
- **Individual Statement Execution**: Added interactive **▶ Run Query** CodeLens above every SQL statement in your `.sql` documents.
- **Accurate Statement Boundary Parsing**: Automatically parses SQL statements (respecting comments, string literals, and quoted identifiers). Running a query executes only the targeted statement, avoiding Athena's `"Only one sql statement is allowed"` error.

#### 2. Catalog Explorer Table Actions
- **Preview Data**: Right-click any table or view in the Catalog Explorer and select **Preview** to execute `SELECT * FROM "<db>"."<table>" LIMIT 10`.
- **Show DDL with Resilient Fallback**: Right-click any table or view and select **Show DDL** to inspect its schema.
  - Generates DDL with Athena-compatible backtick syntax.
  - Automatically falls back to querying AWS Glue Catalog metadata directly (`GetTable`) if Athena's query engine returns `"Queries of this type are not supported"`.
  - Opens the complete DDL in a new SQL text editor tab for reading, copying, and editing.

#### 3. File-Backed Local Saved Queries
- **User-Controlled Lifecycle**: Saved queries persist indefinitely on your machine as real `.sql` files.
- **Dedicated Local Storage**: Files are stored in `<extensionStorage>/saved-queries/<query_name>.sql`.
- **Streamlined Saving**: Only prompts for a query name—no unnecessary catalog or database questions.
- **Top Editor Group Opening**: Clicking a saved query opens the file in the top editor area (`ViewColumn.One`), allowing direct editing and `Ctrl+S` file saving.
- **Open in File Explorer**: Click the folder icon (`$(folder)`) in the Saved Queries header to reveal and manage your query files directly in your operating system's file manager.

#### 4. Local Query History
- **Persistent Execution Log**: Automatically tracks queries executed from the workbench.
- **Rich Metadata**: Displays status (SUCCEEDED, FAILED, RUNNING, CANCELLED), execution time, bytes scanned, and error reasons.
- **Clear History Action**: Easily clear history when desired via the `$(clear-all)` button.
- **Top Editor Opening**: Clicking any history item opens the SQL statement in `ViewColumn.One`.

#### 5. Horizontal Results Split Layout
- **Two-Row Screen Split**: Query results automatically open below the active SQL editor across the full width of the window (`ViewColumn.Two`), providing maximum horizontal space for data tables.
- **Results Viewer**: Built-in pagination, CSV clipboard copy, and file export (CSV / JSON).

#### 6. Enterprise AWS Authentication
- Seamless connection via AWS IAM Access Keys, AWS Named Profiles, and AWS IAM Identity Center (SSO).
- Credentials stored securely via VS Code Secrets Storage API.

---

### How to Install the VSIX Artifact

You can install `aws-athena-sql-client-0.1.0.vsix` into VS Code using either of the following methods:

#### Method 1: Via VS Code User Interface
1. Download `aws-athena-sql-client-0.1.0.vsix` using the link above.
2. Open Visual Studio Code.
3. Open the **Extensions** view (`Ctrl+Shift+X` or `Cmd+Shift+X`).
4. Click the **Views and More Actions...** (`...`) menu at the top of the Extensions view.
5. Select **Install from VSIX...**
6. Select the downloaded `aws-athena-sql-client-0.1.0.vsix` file.

#### Method 2: Via Command Line
```bash
code --install-extension aws-athena-sql-client-0.1.0.vsix
```

---

### License
This release is distributed under the [MIT License](LICENSE).
