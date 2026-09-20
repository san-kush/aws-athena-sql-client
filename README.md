# AWS Athena SQL Client

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://marketplace.visualstudio.com/)
[![Publisher](https://img.shields.io/badge/publisher-sankush-purple.svg)](https://marketplace.visualstudio.com/publishers/sankush)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A lightweight, production-ready Visual Studio Code extension for **Amazon Athena** and **AWS Glue Data Catalog**. Query data lakes, browse catalogs and schemas, manage multiple connections with Browser SSO/IAM, track query history with pagination, and inspect results with built-in export capabilities.

---

## 🌟 Key Features

### 1. Connection Management (`athena.connections`)
- **Activity Bar View**: Manage active and saved connections with intuitive status indicators (green plug for connected, grey for disconnected).
- **Interactive Webview Form**:
  - **Connection Name**: Unique, mandatory name per connection.
  - **Authentication Methods**:
    - **Browser SSO / SAML**: Provides **SAML Identity Provider URL** input with a direct **"Open in Browser"** button to log in via your system's default browser (macOS/Windows) without installing headless tools or chromium.
    - **Access Key ID & Secret Key**: Secure credential storage using VS Code `SecretStorage` (`context.secrets`).
    - **AWS Profile**: Seamless integration with local `~/.aws/credentials` and `~/.aws/config`.
    - **Default Credential Chain**: Standard AWS SDK provider chain.
  - **Dynamic Output Location (`OutputLocation`) Validation**: Automatically marks `Query Result Location (s3://...)` as mandatory when using the `primary` or empty workgroup, and validates URI format.
  - **Encryption Support**: Configure `NONE`, `SSE_S3`, `SSE_KMS`, or `CSE_KMS` with dynamic KMS Key ARN fields.
  - **Test Connection**: Instant background ping (`ListWorkGroupsCommand`) with real-time green/red response banners.
- **Context Actions**: Right-click to **Connect**, **Refresh**, **Duplicate**, **Edit**, or **Delete**.

### 2. Catalog / Schema / Table Explorer (`athena.explorer`)
- **Hierarchical 4-Level Tree**:
  - `Data Catalog` (e.g., `AwsDataCatalog`)
  - `Database / Schema`
  - `Tables & Views` (distinct icons for tables vs virtual views)
  - `Columns` (column name, data type, and partition key indicators)
- **High Performance & Cost-Free**: Metadata is read via AWS Glue APIs (`GetDatabases`, `GetTables`, `GetTable`), preventing unnecessary Athena query charges.

### 3. Query History (`athena.history`)
- **Sorted Execution History**: Displays previous query runs sorted descending by submission time.
- **Local Pagination**: 5 queries per page, up to 10 pages (max 50 queries) with Prev/Next navigation in the view title bar.
- **Rich Status Indicators**: `SUCCEEDED` (green), `FAILED` (red), `RUNNING` / `QUEUED` (blue), and `CANCELLED` (yellow).
- **Execution Metrics**: Inspect elapsed runtime, data scanned in bytes, and exact error messages on hover via Markdown tooltips.
- **Click-to-Open**: Clicking any history item opens the original SQL statement directly in a new editor tab.

### 4. Saved Queries (`athena.savedQueries`)
- **Workgroup Named Queries**: Lists Athena Named Queries associated with your active workgroup.
- **Save from Active Editor**: Use the header `+` button to name and save any SQL statement from the editor.
- **Open & Delete**: Open saved queries into an editor with a single click or delete them via context actions.

### 5. Multi-Tab SQL Editor & Query Execution
- **CodeLens Integration**: Automatically displays **"▶ Run Query"** above top-level SQL statements (`SELECT`, `WITH`, `CREATE`, `INSERT`, etc.) in `.sql` files.
- **Flexible Execution**: Runs either highlighted SQL selection or the entire document via `athena.runQuery` (`Ctrl+Enter` / `Cmd+Enter` or editor title bar).
- **In-Flight Cancellation**: Cancel running queries cleanly via `athena.cancelQuery` or the notification progress dialog.

### 6. Query Results Webview Panel
- **Multi-Tab Results**: Each query run creates an independent result tab (`Result 1`, `Result 2`, ...).
- **Pagination**: Client-side pagination (100 rows per page) for responsive rendering on large result sets.
- **Execution Metrics**: Status, duration, data scanned, total rows, and Query Execution ID prominently displayed.
- **Exporting**:
  - **Copy CSV**: Quick clipboard export.
  - **Export CSV**: Prompts save dialog and writes `.csv` to disk.
  - **Export JSON**: Formats tabular data as structured JSON.
- **Theme Native**: Styled entirely with native VS Code design tokens (`var(--vscode-*)`).

---

## 🛠️ Architecture

```
athena-query-workbench/
├── package.json               # Extension manifest with views, commands & menus
├── tsconfig.json              # TypeScript strict configuration (ES2022)
├── esbuild.mjs                # Bundler configuration
├── media/                     # Amazon Athena branding & themed SVG icons
│   ├── icon.png               # High-res marketplace icon
│   ├── icon.svg               # Activity bar icon (monochrome currentColor)
│   ├── dark/                  # 10 icons for dark theme
│   └── light/                 # 10 icons for light theme
└── src/
    ├── extension.ts           # Extension entry point & lifecycle
    ├── models/
    │   └── types.ts           # Shared TypeScript interfaces & types
    ├── services/
    │   ├── ConnectionManager.ts  # Connection state & secret storage
    │   └── AthenaClientService.ts# AWS SDK v3 client & Glue integrations
    ├── providers/
    │   ├── ConnectionsTreeProvider.ts
    │   ├── CatalogTreeProvider.ts
    │   ├── QueryHistoryTreeProvider.ts
    │   ├── SavedQueriesTreeProvider.ts
    │   └── SqlCodeLensProvider.ts
    ├── panels/
    │   ├── ConnectionFormPanel.ts # Interactive connection webview
    │   └── ResultsPanel.ts        # Paginated results & export panel
    ├── commands/
    │   ├── runQuery.ts
    │   └── cancelQuery.ts
    └── utils/
        ├── constants.ts
        └── formatters.ts
```

---

## 🚀 Getting Started

### Prerequisites
- Visual Studio Code version `1.85.0` or higher
- Node.js `18+` or `20+` (for development)
- AWS credentials with permissions for Athena and Glue

### Installation & Development
1. Clone the repository:
   ```bash
   git clone https://github.com/san-kush/aws-athena-sql-client.git
   cd aws-athena-sql-client
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Compile & Bundle:
   ```bash
   npm run compile   # TypeScript check (strict mode)
   npm run build     # esbuild bundle to dist/extension.js
   ```
4. Press `F5` in VS Code to launch the **Extension Development Host**.

---

## 🔒 Security & Best Practices
- **Credentials Protection**: Sensitive AWS keys are stored strictly in VS Code `SecretStorage` (`context.secrets`) using OS-level keychain encryption. Non-sensitive configurations are stored in `globalState`.
- **Content Security Policy (CSP)**: All Webviews use strict CSP meta tags with unique cryptographic nonces.
- **Zero Heavy Runtimes**: Pure TypeScript and lightweight AWS SDK v3 modular packages without unnecessary chromium or heavy browser dependencies.

---

## 📄 License
MIT © [sankush](https://github.com/san-kush)

