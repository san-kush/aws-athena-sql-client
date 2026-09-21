# Changelog

All notable changes to the **AWS Athena SQL Client** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.2] - 2026-09-21

### Added
- **Interactive Column Header Sorting in Query Results**:
  - Click any column header in the query results table to cycle through **Ascending (▲)**, **Descending (▼)**, and **Original order**.
  - Intelligent type-aware comparison supporting numeric sorting, natural text sorting (`localeCompare`), and null-safe ordering.
  - Sorting applies across the entire dataset with automatic page-1 reset, state persistence across tab switches, and preserved ordering on CSV/JSON export.

### Fixed
- **Browser Launch Reliability (Code: 0 Fix)**:
  - Fixed `Failed to launch the browser process: Code: 0` error by completely sanitizing environment variables (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `VSCODE_*`) passed from the VS Code Extension Host to the spawned browser process.
  - Added flags to prevent Microsoft Edge background process singleton handover and Startup Boost interference (`--disable-features=msEdgeStartupBoost`, `--disable-background-mode`, `--disable-background-networking`, `--no-sandbox`, `--disable-gpu`).
  - Added `ignoreDefaultArgs: ['--enable-automation']` so automated test bars do not trigger corporate IdP security blocks.
  - Added multi-browser automatic fallback: prioritizes Google Chrome and automatically falls back to Microsoft Edge if needed.
- **Packaging Optimization**:
  - Excluded development and scratch scripts from the distributed `.vsix` package to keep artifact size lean.

---

## [0.1.1] - 2026-09-21

### Added
- **Automated Interactive Browser SAML Login (Okta / Azure AD / Ping)**:
  - Added dedicated SAML authentication flow requiring only the corporate Identity Provider URL.
  - Automatically launches your system's existing Microsoft Edge or Google Chrome browser (via lightweight `puppeteer-core`, without any bulky Chromium downloads).
  - Automates network interception of the SAML assertion and role selection, assumes role via AWS STS `AssumeRoleWithSAMLCommand`, and **automatically closes the browser window**.
  - Temporary STS credentials and session token are securely stored in VS Code's encrypted secrets store.
  - Automatically detects expired SAML sessions on connection and prompts for seamless 1-click re-authentication.

### Fixed
- **Table DDL First Line Missing**: Fixed an issue where the `CREATE TABLE` / `CREATE EXTERNAL TABLE` statement line was omitted when executing "Show DDL" on tables.
- **View DDL Decoding**: Corrected view DDL generation by decoding Athena & Glue Data Catalog Presto/Trino view definitions from `ViewOriginalText`.
- **Query Result Set Vanishing on Tab Switch**: Fixed result tables disappearing when switching between query result tabs by enabling `retainContextWhenHidden` and integrating VS Code state persistence (`vscode.getState()` / `vscode.setState()`).

### Documentation & Maintenance
- Added high-resolution feature screenshots in `README.md`.
- Added Support & Feedback section linking to GitHub Issues.
- Streamlined documentation for Marketplace consumers.

---

## [0.1.0] - 2026-09-21

### Added
- **Multi-Statement SQL CodeLens**: Added "▶ Run Query" CodeLens above each individual SQL statement in `.sql` editors. Parses statement boundaries to execute only the targeted query without "Only one sql statement is allowed" errors.
- **Catalog Explorer Table Actions**:
  - **Preview**: Right-click on any table or view to execute `SELECT * FROM "<db>"."<table>" LIMIT 10`.
  - **Show DDL**: Right-click on any table or view to generate and display the DDL in a new SQL text editor tab. Includes automatic fallback to AWS Glue Data Catalog metadata (`GetTable`) if Athena's query engine rejects the command.
- **File-Backed Local Saved Queries**:
  - Saved queries are stored locally as individual `.sql` files on disk.
  - Quick-save queries without prompts for database or catalog.
  - Added "Open Saved Queries Folder" action (`$(folder)`) to view, copy, or manage query files in your operating system's file manager.
  - Clicking any saved query opens the actual `.sql` file in the top editor area (`ViewColumn.One`), supporting direct saving with `Ctrl+S`.
- **Local Query History**:
  - Tracks locally executed queries with execution status, run time, data scanned in bytes, and error messages.
  - Persisted locally across VS Code restarts.
  - Clear History action (`$(clear-all)`).
  - Clicking any history item opens the SQL query in the top editor area (`ViewColumn.One`).
- **Horizontal Results Layout**:
  - Query results open in a two-row horizontal layout below the editor (`ViewColumn.Two`), maximizing horizontal width for tabular data.
  - Tabular data viewer with pagination, CSV copy, CSV export, and JSON export.
- **AWS Connection Management**:
  - Support for multiple named connections.
  - Authentication options: AWS IAM Access Keys, AWS Named Profile, and AWS IAM Identity Center (SSO).
  - Secure credential storage using VS Code Secrets Storage API.
  - Glue Data Catalog tree browser for catalogs, databases, tables, views, and columns (including partition keys).
- **Licensing**: Licensed under the open-source MIT License.

---

[0.1.2]: https://github.com/san-kush/aws-athena-sql-client/releases/tag/v0.1.2
[0.1.1]: https://github.com/san-kush/aws-athena-sql-client/releases/tag/v0.1.1
[0.1.0]: https://github.com/san-kush/aws-athena-sql-client/releases/tag/v0.1.0

