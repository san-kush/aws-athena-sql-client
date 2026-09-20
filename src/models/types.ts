export type AuthMethod = 'accessKeys' | 'profile' | 'sso' | 'default';
export type EncryptionType = 'NONE' | 'SSE_S3' | 'SSE_KMS' | 'CSE_KMS';
export type QueryStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface ConnectionConfig {
  id: string;
  name: string;
  authMethod: AuthMethod;
  region: string;
  workgroup: string;
  outputLocation: string;
  catalog: string;
  encryptionType: EncryptionType;
  kmsKeyArn?: string;
  profileName?: string;
  ssoStartUrl?: string;
  ssoRegion?: string;
  ssoAccountId?: string;
  ssoRoleName?: string;
}

export interface ConnectionSecrets {
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface QueryHistoryEntry {
  queryExecutionId: string;
  query: string;
  status: QueryStatus;
  submissionTime?: Date;
  completionTime?: Date;
  elapsedTimeMs?: number;
  dataScannedBytes?: number;
  workgroup?: string;
  database?: string;
  errorMessage?: string;
}

export interface SavedQuery {
  namedQueryId: string;
  name: string;
  description?: string;
  database?: string;
  queryString: string;
  workgroup?: string;
  filePath?: string;
}

export interface CatalogNodeInfo {
  type: 'catalog' | 'database' | 'table' | 'view' | 'column';
  name: string;
  catalogName?: string;
  databaseName?: string;
  tableName?: string;
  dataType?: string;
  isPartitionKey?: boolean;
}

export interface QueryResult {
  queryExecutionId: string;
  columns: ColumnInfo[];
  rows: string[][];
  totalRows: number;
  status: QueryStatus;
  elapsedTimeMs?: number;
  dataScannedBytes?: number;
  outputLocation?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
}
