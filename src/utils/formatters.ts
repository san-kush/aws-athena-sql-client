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
