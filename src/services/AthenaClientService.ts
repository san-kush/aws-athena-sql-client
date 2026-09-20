import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StopQueryExecutionCommand,
  ListQueryExecutionsCommand,
  BatchGetQueryExecutionCommand,
  ListNamedQueriesCommand,
  BatchGetNamedQueryCommand,
  CreateNamedQueryCommand,
  DeleteNamedQueryCommand,
  ListWorkGroupsCommand,
  ResultConfiguration,
  EncryptionConfiguration
} from '@aws-sdk/client-athena';
import {
  GlueClient,
  GetDatabasesCommand,
  GetTablesCommand,
  GetTableCommand
} from '@aws-sdk/client-glue';
import { fromIni, fromSSO } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
// 'open' v10+ is ESM-only; use dynamic import for CJS compat
async function openUrl(url: string): Promise<void> {
  const { default: open } = await import('open');
  await open(url);
}
import type { ConnectionConfig, ConnectionSecrets, QueryResult, QueryHistoryEntry, SavedQuery, ColumnInfo, QueryStatus } from '../models/types';
import { DEFAULT_CATALOG, POLL_INTERVALS } from '../utils/constants';
import { formatViewDdl } from '../utils/formatters';

export class AthenaClientService {
  private _athenaClient: AthenaClient | undefined;
  private _glueClient: GlueClient | undefined;
  private _config: ConnectionConfig | undefined;
  private _currentQueryExecutionId: string | undefined;

  public async setConnection(config: ConnectionConfig, secrets: ConnectionSecrets): Promise<void> {
    let credentials: AwsCredentialIdentityProvider | undefined;

    if (config.authMethod === 'accessKeys') {
      credentials = async () => ({
        accessKeyId: secrets.accessKeyId!,
        secretAccessKey: secrets.secretAccessKey!
      });
    } else if (config.authMethod === 'profile') {
      credentials = fromIni({ profile: config.profileName });
    } else if (config.authMethod === 'sso') {
      // Create SSO credentials provider and pass open function to allow launching
      // the authorization URL in the user's default browser if needed.
      credentials = fromSSO({
        ssoStartUrl: config.ssoStartUrl!,
        ssoAccountId: config.ssoAccountId!,
        ssoRoleName: config.ssoRoleName!,
        ssoRegion: config.ssoRegion || config.region,
        clientConfig: {
          // Some AWS SDK versions/plugins might use this for SSO interactive logins
          // @ts-ignore
          customBrowser: (url: string) => openUrl(url)
        }
      });
    } else if (config.authMethod === 'default') {
      credentials = undefined;
    }

    this._athenaClient = new AthenaClient({ region: config.region, credentials });
    this._glueClient = new GlueClient({ region: config.region, credentials });
    this._config = config;
  }

  public dispose(): void {
    this._athenaClient?.destroy();
    this._glueClient?.destroy();
    this._athenaClient = undefined;
    this._glueClient = undefined;
  }

  private ensureClient(): AthenaClient {
    if (!this._athenaClient) {
      throw new Error('Athena client is not initialized. Please connect first.');
    }
    return this._athenaClient;
  }

  private ensureGlueClient(): GlueClient {
    if (!this._glueClient) {
      throw new Error('Glue client is not initialized. Please connect first.');
    }
    return this._glueClient;
  }

  public async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const client = this.ensureClient();
      await client.send(new ListWorkGroupsCommand({ MaxResults: 1 }));
      return { success: true, message: 'Connection successful' };
    } catch (error: any) {
      return { success: false, message: error.message || 'Unknown error' };
    }
  }

  public async getCatalogs(): Promise<string[]> {
    return [this._config?.catalog || DEFAULT_CATALOG];
  }

  public async getDatabases(catalogName: string): Promise<string[]> {
    const client = this.ensureGlueClient();
    const databases: string[] = [];
    let nextToken: string | undefined;

    do {
      const response = await client.send(new GetDatabasesCommand({ NextToken: nextToken }));
      if (response.DatabaseList) {
        databases.push(...response.DatabaseList.map(db => db.Name || '').filter(name => name.length > 0));
      }
      nextToken = response.NextToken;
    } while (nextToken);

    return databases.sort((a, b) => a.localeCompare(b));
  }

  public async getTables(catalogName: string, databaseName: string): Promise<Array<{name: string; type: 'table' | 'view'}>> {
    const client = this.ensureGlueClient();
    const tables: Array<{name: string; type: 'table' | 'view'}> = [];
    let nextToken: string | undefined;

    do {
      const response = await client.send(new GetTablesCommand({ DatabaseName: databaseName, NextToken: nextToken }));
      if (response.TableList) {
        for (const table of response.TableList) {
          if (table.Name) {
            const isView = table.TableType?.includes('VIEW') || table.TableType === 'VIRTUAL_VIEW';
            tables.push({ name: table.Name, type: isView ? 'view' : 'table' });
          }
        }
      }
      nextToken = response.NextToken;
    } while (nextToken);

    return tables.sort((a, b) => a.name.localeCompare(b.name));
  }

  public async getColumns(catalogName: string, databaseName: string, tableName: string): Promise<ColumnInfo[]> {
    const client = this.ensureGlueClient();
    const response = await client.send(new GetTableCommand({ DatabaseName: databaseName, Name: tableName }));
    
    const columns: ColumnInfo[] = [];
    
    const storageCols = response.Table?.StorageDescriptor?.Columns || [];
    for (const col of storageCols) {
      if (col.Name) {
        columns.push({ name: col.Name, type: col.Type || 'unknown' });
      }
    }
    
    const partitionCols = response.Table?.PartitionKeys || [];
    for (const col of partitionCols) {
      if (col.Name) {
        columns.push({ name: col.Name, type: col.Type || 'unknown' });
      }
    }
    
    return columns;
  }

  public async getTableDdl(catalogName: string, databaseName: string, tableName: string): Promise<string> {
    const client = this.ensureGlueClient();
    const response = await client.send(new GetTableCommand({ DatabaseName: databaseName, Name: tableName }));
    const table = response.Table;
    if (!table) {
      throw new Error(`Table ${databaseName}.${tableName} not found in Glue catalog`);
    }

    // If it's a view, return parsed and formatted CREATE OR REPLACE VIEW statement
    const isView = table.TableType === 'VIRTUAL_VIEW' || table.TableType?.includes('VIEW');
    const viewRawText = table.ViewOriginalText || table.ViewExpandedText;
    if (viewRawText) {
      return formatViewDdl(databaseName, tableName, viewRawText);
    }
    if (isView) {
      return `-- View definition not available in Glue catalog for "${databaseName}"."${tableName}";`;
    }

    // Build CREATE EXTERNAL TABLE DDL
    const lines: string[] = [];
    const isExternal = table.TableType === 'EXTERNAL_TABLE' || table.Parameters?.['EXTERNAL'] === 'TRUE';
    lines.push(`CREATE ${isExternal ? 'EXTERNAL ' : ''}TABLE \`${databaseName}\`.\`${tableName}\` (`);

    const cols = table.StorageDescriptor?.Columns || [];
    const colDefs = cols.map((col, idx) => {
      const comment = col.Comment ? ` COMMENT '${col.Comment.replace(/'/g, "\\'")}'` : '';
      const comma = idx < cols.length - 1 ? ',' : '';
      return `  \`${col.Name}\` ${col.Type}${comment}${comma}`;
    });
    lines.push(colDefs.join('\n'));
    lines.push(')');

    // Partition keys
    const partitionKeys = table.PartitionKeys || [];
    if (partitionKeys.length > 0) {
      lines.push('PARTITIONED BY (');
      const partDefs = partitionKeys.map((pk, idx) => {
        const comment = pk.Comment ? ` COMMENT '${pk.Comment.replace(/'/g, "\\'")}'` : '';
        const comma = idx < partitionKeys.length - 1 ? ',' : '';
        return `  \`${pk.Name}\` ${pk.Type}${comment}${comma}`;
      });
      lines.push(partDefs.join('\n'));
      lines.push(')');
    }

    // Row format / Serde
    const sd = table.StorageDescriptor;
    if (sd?.SerdeInfo?.SerializationLibrary) {
      lines.push(`ROW FORMAT SERDE '${sd.SerdeInfo.SerializationLibrary}'`);
      if (sd.SerdeInfo.Parameters && Object.keys(sd.SerdeInfo.Parameters).length > 0) {
        lines.push('WITH SERDEPROPERTIES (');
        const params = Object.entries(sd.SerdeInfo.Parameters)
          .map(([k, v], idx, arr) => `  '${k}' = '${(v || '').replace(/'/g, "\\'")}'${idx < arr.length - 1 ? ',' : ''}`);
        lines.push(params.join('\n'));
        lines.push(')');
      }
    }

    // Stored as input / output format
    if (sd?.InputFormat && sd?.OutputFormat) {
      lines.push('STORED AS INPUTFORMAT');
      lines.push(`  '${sd.InputFormat}'`);
      lines.push('OUTPUTFORMAT');
      lines.push(`  '${sd.OutputFormat}'`);
    }

    // Location
    if (sd?.Location) {
      lines.push('LOCATION');
      lines.push(`  '${sd.Location}'`);
    }

    // Table properties
    if (table.Parameters && Object.keys(table.Parameters).length > 0) {
      const filteredParams = Object.entries(table.Parameters)
        .filter(([k]) => !k.startsWith('transient_lastDdlTime'));
      if (filteredParams.length > 0) {
        lines.push('TBLPROPERTIES (');
        const props = filteredParams
          .map(([k, v], idx, arr) => `  '${k}' = '${(v || '').replace(/'/g, "\\'")}'${idx < arr.length - 1 ? ',' : ''}`);
        lines.push(props.join('\n'));
        lines.push(')');
      }
    }

    lines.push(';');
    return lines.join('\n');
  }

  public async executeQuery(sql: string, database?: string, onStatusChange?: (status: string) => void): Promise<QueryResult> {
    const client = this.ensureClient();
    if (!this._config) {
      throw new Error('Connection config is missing');
    }

    const resultConfig: ResultConfiguration = {
      OutputLocation: this._config.outputLocation
    };

    if (this._config.encryptionType !== 'NONE') {
      resultConfig.EncryptionConfiguration = {
        EncryptionOption: this._config.encryptionType as any
      };
      if (this._config.kmsKeyArn) {
        resultConfig.EncryptionConfiguration.KmsKey = this._config.kmsKeyArn;
      }
    }

    const startCmd = new StartQueryExecutionCommand({
      QueryString: sql,
      QueryExecutionContext: {
        Database: database,
        Catalog: this._config.catalog || DEFAULT_CATALOG
      },
      WorkGroup: this._config.workgroup,
      ResultConfiguration: resultConfig
    });

    const startResponse = await client.send(startCmd);
    const executionId = startResponse.QueryExecutionId;
    if (!executionId) {
      throw new Error('Failed to start query execution');
    }
    this._currentQueryExecutionId = executionId;

    let status = 'QUEUED';
    let pollIndex = 0;
    let queryExecution: any;

    while (status === 'QUEUED' || status === 'RUNNING') {
      const delay = POLL_INTERVALS[Math.min(pollIndex, POLL_INTERVALS.length - 1)];
      await new Promise(resolve => setTimeout(resolve, delay));
      pollIndex++;

      const getCmd = new GetQueryExecutionCommand({ QueryExecutionId: executionId });
      const getResponse = await client.send(getCmd);
      queryExecution = getResponse.QueryExecution;
      status = queryExecution?.Status?.State || 'FAILED';

      if (onStatusChange) {
        onStatusChange(status);
      }
    }

    this._currentQueryExecutionId = undefined;

    if (status === 'FAILED') {
      throw new Error(queryExecution?.Status?.StateChangeReason || 'Query failed');
    }
    if (status === 'CANCELLED') {
      throw new Error('Query was cancelled');
    }

    // SUCCEEDED
    const resultsCmd = new GetQueryResultsCommand({ QueryExecutionId: executionId });
    const resultsResponse = await client.send(resultsCmd);
    
    const rows: string[][] = [];
    const columns: ColumnInfo[] = [];

    const resultMetadata = resultsResponse.ResultSet?.ResultSetMetadata?.ColumnInfo || [];
    for (const col of resultMetadata) {
      columns.push({ name: col.Name || 'unknown', type: col.Type || 'unknown' });
    }

    const rawRows = resultsResponse.ResultSet?.Rows || [];
    // In Athena GetQueryResults, SELECT/DML queries include a duplicate header row as rawRows[0]
    // where each column value matches the column name from ResultSetMetadata.
    // DDL statements (like SHOW CREATE TABLE, SHOW CREATE VIEW) do NOT include a header row;
    // rawRows[0] is the first line of the DDL statement (e.g. "CREATE EXTERNAL TABLE ...").
    let startIndex = 0;
    if (rawRows.length > 0 && columns.length > 0) {
      const firstRowValues = rawRows[0].Data?.map(d => d.VarCharValue ?? '') || [];
      const isHeaderRow = firstRowValues.length === columns.length &&
        firstRowValues.every((val, idx) => val.toLowerCase() === (columns[idx].name || '').toLowerCase());
      if (isHeaderRow) {
        startIndex = 1;
      }
    }

    for (let i = startIndex; i < rawRows.length; i++) {
      const row = rawRows[i];
      const rowData = row.Data?.map(d => d.VarCharValue ?? '') || [];
      rows.push(rowData);
    }

    return {
      queryExecutionId: executionId,
      columns,
      rows,
      totalRows: rows.length,
      status: status as QueryStatus,
      elapsedTimeMs: queryExecution?.Statistics?.EngineExecutionTimeInMillis,
      dataScannedBytes: queryExecution?.Statistics?.DataScannedInBytes,
      outputLocation: queryExecution?.ResultConfiguration?.OutputLocation
    };
  }

  public async cancelQuery(queryExecutionId: string): Promise<void> {
    const client = this.ensureClient();
    await client.send(new StopQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
  }

  public async getQueryHistory(maxResults: number = 50): Promise<QueryHistoryEntry[]> {
    const client = this.ensureClient();
    if (!this._config) {
      throw new Error('Connection config is missing');
    }

    const listCmd = new ListQueryExecutionsCommand({
      WorkGroup: this._config.workgroup,
      MaxResults: maxResults
    });
    const listResponse = await client.send(listCmd);
    const executionIds = listResponse.QueryExecutionIds || [];

    if (executionIds.length === 0) {
      return [];
    }

    const history: QueryHistoryEntry[] = [];
    for (let i = 0; i < executionIds.length; i += 50) {
      const batchIds = executionIds.slice(i, i + 50);
      const batchCmd = new BatchGetQueryExecutionCommand({ QueryExecutionIds: batchIds });
      const batchResponse = await client.send(batchCmd);
      
      const executions = batchResponse.QueryExecutions || [];
      for (const exec of executions) {
        if (exec.QueryExecutionId && exec.Query) {
          history.push({
            queryExecutionId: exec.QueryExecutionId,
            query: exec.Query,
            status: (exec.Status?.State || 'FAILED') as QueryStatus,
            submissionTime: exec.Status?.SubmissionDateTime ? new Date(exec.Status.SubmissionDateTime) : undefined,
            completionTime: exec.Status?.CompletionDateTime ? new Date(exec.Status.CompletionDateTime) : undefined,
            elapsedTimeMs: exec.Statistics?.EngineExecutionTimeInMillis,
            dataScannedBytes: exec.Statistics?.DataScannedInBytes,
            workgroup: exec.WorkGroup,
            database: exec.QueryExecutionContext?.Database,
            errorMessage: exec.Status?.StateChangeReason
          });
        }
      }
    }

    history.sort((a, b) => {
      const timeA = a.submissionTime?.getTime() || 0;
      const timeB = b.submissionTime?.getTime() || 0;
      return timeB - timeA;
    });

    return history;
  }

  public async getSavedQueries(): Promise<SavedQuery[]> {
    const client = this.ensureClient();
    if (!this._config) {
      throw new Error('Connection config is missing');
    }

    const listCmd = new ListNamedQueriesCommand({ WorkGroup: this._config.workgroup });
    const listResponse = await client.send(listCmd);
    const queryIds = listResponse.NamedQueryIds || [];

    if (queryIds.length === 0) {
      return [];
    }

    const savedQueries: SavedQuery[] = [];
    for (let i = 0; i < queryIds.length; i += 50) {
      const batchIds = queryIds.slice(i, i + 50);
      const batchCmd = new BatchGetNamedQueryCommand({ NamedQueryIds: batchIds });
      const batchResponse = await client.send(batchCmd);
      
      const queries = batchResponse.NamedQueries || [];
      for (const q of queries) {
        if (q.NamedQueryId && q.Name && q.Database && q.QueryString) {
          savedQueries.push({
            namedQueryId: q.NamedQueryId,
            name: q.Name,
            description: q.Description,
            database: q.Database,
            queryString: q.QueryString,
            workgroup: q.WorkGroup
          });
        }
      }
    }

    return savedQueries;
  }

  public async saveQuery(name: string, description: string, database: string, sql: string): Promise<string> {
    const client = this.ensureClient();
    if (!this._config) {
      throw new Error('Connection config is missing');
    }

    const cmd = new CreateNamedQueryCommand({
      Name: name,
      Description: description,
      Database: database,
      QueryString: sql,
      WorkGroup: this._config.workgroup
    });
    
    const response = await client.send(cmd);
    if (!response.NamedQueryId) {
      throw new Error('Failed to create named query');
    }
    return response.NamedQueryId;
  }

  public async deleteSavedQuery(namedQueryId: string): Promise<void> {
    const client = this.ensureClient();
    await client.send(new DeleteNamedQueryCommand({ NamedQueryId: namedQueryId }));
  }
}
