import * as crypto from 'crypto';

export function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null) { return 'N/A'; }
  if (bytes === 0) { return '0 B'; }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null) { return 'N/A'; }
  if (ms < 1000) { return `${ms}ms`; }
  const seconds = ms / 1000;
  if (seconds < 60) { return `${seconds.toFixed(1)}s`; }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = (seconds % 60).toFixed(0);
  return `${minutes}m ${remainingSeconds}s`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function truncateQuery(query: string, maxLength: number = 80): string {
  const singleLine = query.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) { return singleLine; }
  return singleLine.substring(0, maxLength - 3) + '...';
}

/**
 * Formats a view definition into a clean, executable SQL CREATE OR REPLACE VIEW statement.
 * Handles Athena / Presto base64-encoded JSON stored in Glue Data Catalog:
 * /* Presto View: <base64> *\/
 */
export function formatViewDdl(databaseName: string, tableName: string, rawViewText: string): string {
  if (!rawViewText) {
    return `-- View definition not available for "${databaseName}"."${tableName}";`;
  }

  const text = rawViewText.trim();

  // 1. Check for Athena Presto/Trino view format: /* Presto View: <base64> */
  const prestoMatch = text.match(/\/\*\s*Presto View:\s*([A-Za-z0-9+/=]+)\s*\*\//i);
  if (prestoMatch && prestoMatch[1]) {
    try {
      const cleanB64 = prestoMatch[1].replace(/\s+/g, '');
      const decodedJson = Buffer.from(cleanB64, 'base64').toString('utf-8');
      const parsed = JSON.parse(decodedJson);
      if (parsed.originalSql) {
        const sql = parsed.originalSql.trim().replace(/;+$/, '');
        if (/^\s*CREATE\s+/i.test(sql)) {
          return `${sql};`;
        }
        return `CREATE OR REPLACE VIEW "${databaseName}"."${tableName}" AS\n${sql};`;
      }
    } catch {
      // Fall through if decoding or JSON parse fails
    }
  }

  // 2. Already a full CREATE VIEW statement
  if (/^\s*CREATE\s+/i.test(text)) {
    const clean = text.replace(/;+$/, '');
    return `${clean};`;
  }

  // 3. Plain SELECT or WITH query
  if (/^\s*SELECT\s+/i.test(text) || /^\s*WITH\s+/i.test(text)) {
    const clean = text.replace(/;+$/, '');
    return `CREATE OR REPLACE VIEW "${databaseName}"."${tableName}" AS\n${clean};`;
  }

  // Fallback
  return text.endsWith(';') ? text : `${text};`;
}
