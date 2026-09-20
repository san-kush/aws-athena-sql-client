export const EXT_ID = 'aws-athena-sql-client';

// View IDs
export const VIEW_CONNECTIONS = 'athena.connections';
export const VIEW_EXPLORER = 'athena.explorer';
export const VIEW_HISTORY = 'athena.history';
export const VIEW_SAVED_QUERIES = 'athena.savedQueries';

// Command IDs
export const CMD_ADD_CONNECTION = 'athena.addConnection';
export const CMD_EDIT_CONNECTION = 'athena.editConnection';
export const CMD_DELETE_CONNECTION = 'athena.deleteConnection';
export const CMD_DUPLICATE_CONNECTION = 'athena.duplicateConnection';
export const CMD_CONNECT = 'athena.connect';
export const CMD_DISCONNECT = 'athena.disconnect';
export const CMD_REFRESH_CONNECTIONS = 'athena.refreshConnections';
export const CMD_REFRESH_EXPLORER = 'athena.refreshExplorer';
export const CMD_REFRESH_HISTORY = 'athena.refreshHistory';
export const CMD_CLEAR_HISTORY = 'athena.clearHistory';
export const CMD_REFRESH_SAVED_QUERIES = 'athena.refreshSavedQueries';
export const CMD_RUN_QUERY = 'athena.runQuery';
export const CMD_CANCEL_QUERY = 'athena.cancelQuery';
export const CMD_SAVE_QUERY = 'athena.saveQuery';
export const CMD_OPEN_SAVED_QUERIES_FOLDER = 'athena.openSavedQueriesFolder';
export const CMD_DELETE_SAVED_QUERY = 'athena.deleteSavedQuery';
export const CMD_OPEN_SAVED_QUERY = 'athena.openSavedQuery';
export const CMD_OPEN_HISTORY_QUERY = 'athena.openHistoryQuery';
export const CMD_HISTORY_NEXT_PAGE = 'athena.historyNextPage';
export const CMD_HISTORY_PREV_PAGE = 'athena.historyPrevPage';
export const CMD_PREVIEW_TABLE = 'athena.previewTable';
export const CMD_SHOW_TABLE_DDL = 'athena.showTableDdl';

// Storage keys
export const STORAGE_CONNECTIONS = 'athena.connections';
export const STORAGE_HISTORY = 'athena.history';
export const STORAGE_SAVED_QUERIES = 'athena.savedQueries';
export const SECRET_PREFIX = 'athena.secret.';

// Pagination
export const HISTORY_PAGE_SIZE = 10;
export const HISTORY_MAX_PAGES = 10;
export const RESULT_PAGE_SIZE = 100;

// Defaults
export const DEFAULT_REGION = 'us-east-1';
export const DEFAULT_WORKGROUP = 'primary';
export const DEFAULT_CATALOG = 'AwsDataCatalog';

// Polling intervals (exponential backoff)
export const POLL_INTERVALS = [500, 1000, 2000, 4000, 5000];
