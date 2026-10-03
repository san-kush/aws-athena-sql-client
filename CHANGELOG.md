# Changelog

All notable changes to the **AWS Athena SQL Client** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.3] - 2026-10-03

### Fixed
- **Browser SAML Login — credentials were discarded on success**: A successful login always reported `Browser closed before SAML authentication could complete`. Closing the browser fired puppeteer's `disconnected` event, and the handler settled the promise as an error before the credentials could be returned. Intentional shutdowns are now distinguished from the user closing the window, so the result is delivered. The same race was also replacing every genuine error message, so AWS/STS failures now surface their real cause.
- **Blank white login window**: The login window opened unpainted, with no tab strip or address bar, making it impossible to sign in. `puppeteer.launch()` spawns the browser as an attached child with piped stdio, which on Windows produces a browser whose window never presents a frame — CDP responded, navigation returned HTTP 200, and screenshots rendered correctly, but nothing was drawn. The browser is now started the way a normal application launch does (detached) and attached to over its debugging port.
- **Login window stuck on `about:blank`**: Immediately after attaching, a page target can exist while still reporting an empty URL; navigating it in that state hung silently with no error. The login URL is now handed to the browser on its command line so the browser performs the first navigation itself.
- **`Unexpected end of JSON input` and being asked to sign in twice**: The browser's debugging endpoint was discovered over HTTP, which fails inside the VS Code extension host because it applies its own proxy handling to Node's HTTP module. After a 45 second wait the extension killed the browser mid-login and reopened the flow in a second browser. Discovery now reads the browser's `DevToolsActivePort` file directly — no HTTP involved — and the fallback to a second browser only happens when a browser fails to start at all, never once a window is on screen.
- **Orphaned browser windows**: A failed login could leave a browser window open with no way to close it, because Microsoft Edge relaunches itself and the originally spawned process had already exited. Cleanup now also sweeps any browser process still using the login's temporary profile, and stale profiles are removed.
- **Login no longer hangs**: Added renderer-crash detection, a watchdog for the window disappearing without the browser exiting, and reporting of network failures (DNS, proxy, TLS) with the browser's actual error code. Previously any of these left the login spinning for the full five minute timeout with no explanation.

### Added
- **"AWS Athena SQL Client" output channel**: Each step of the browser login (launch, navigation, role selection, STS call, cleanup) is written to a dedicated output channel, and failures offer a **Show Log** button.

### Changed
- **New extension icon**: Refreshed Marketplace and Activity Bar icons.
- **Packaging — the extension is now self-contained**: `puppeteer-core` was marked as an external at build time while `node_modules` is excluded from the `.vsix`, so browser SAML login would have failed with `Cannot find module 'puppeteer-core'` in an installed extension even though it worked under F5 debugging. All runtime dependencies are now bundled, and a `vscode:prepublish` step guarantees the published bundle is a fresh production build.
- Browser detection now prefers Google Chrome over Microsoft Edge, matching the previously documented intent.
- Dropped `--no-sandbox` from the browser launch (added in 0.1.2), so the browser sandbox stays enabled.

### Removed
- Unused `open` dependency.

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

[0.1.3]: https://github.com/san-kush/aws-athena-sql-client/releases/tag/v0.1.3
[0.1.2]: https://github.com/san-kush/aws-athena-sql-client/releases/tag/v0.1.2
[0.1.1]: https://github.com/san-kush/aws-athena-sql-client/releases/tag/v0.1.1
[0.1.0]: https://github.com/san-kush/aws-athena-sql-client/releases/tag/v0.1.0

