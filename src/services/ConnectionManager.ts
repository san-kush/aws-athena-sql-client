import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { ConnectionConfig, ConnectionSecrets } from '../models/types';
import { STORAGE_CONNECTIONS, SECRET_PREFIX } from '../utils/constants';

export class ConnectionManager {
  private _connections: ConnectionConfig[] = [];
  private _activeConnectionId: string | undefined;

  private _onDidChangeConnections = new vscode.EventEmitter<void>();
  public readonly onDidChangeConnections = this._onDidChangeConnections.event;

  private _onDidChangeActiveConnection = new vscode.EventEmitter<ConnectionConfig | undefined>();
  public readonly onDidChangeActiveConnection = this._onDidChangeActiveConnection.event;

  constructor(private context: vscode.ExtensionContext) {
    this._connections = this.context.globalState.get<ConnectionConfig[]>(STORAGE_CONNECTIONS, []);
  }

  public getConnections(): ConnectionConfig[] {
    return this._connections;
  }

  public getActiveConnection(): ConnectionConfig | undefined {
    return this._connections.find(c => c.id === this._activeConnectionId);
  }

  public isConnected(id: string): boolean {
    return this._activeConnectionId === id;
  }

  public async setActiveConnection(id: string): Promise<void> {
    this._activeConnectionId = id;
    this._onDidChangeActiveConnection.fire(this.getActiveConnection());
  }

  public clearActiveConnection(): void {
    this._activeConnectionId = undefined;
    this._onDidChangeActiveConnection.fire(undefined);
  }

  public async saveConnection(config: ConnectionConfig, secrets: ConnectionSecrets): Promise<void> {
    const index = this._connections.findIndex(c => c.id === config.id);
    if (index >= 0) {
      this._connections[index] = config;
    } else {
      this._connections.push(config);
    }
    
    await this.persist();
    await this.context.secrets.store(SECRET_PREFIX + config.id, JSON.stringify(secrets));
    this._onDidChangeConnections.fire();
  }

  public async deleteConnection(id: string): Promise<void> {
    const index = this._connections.findIndex(c => c.id === id);
    if (index >= 0) {
      this._connections.splice(index, 1);
      await this.persist();
      await this.context.secrets.delete(SECRET_PREFIX + id);
      
      if (this._activeConnectionId === id) {
        this.clearActiveConnection();
      }
      this._onDidChangeConnections.fire();
    }
  }

  public async duplicateConnection(id: string): Promise<void> {
    const existing = this._connections.find(c => c.id === id);
    if (!existing) {
      throw new Error(`Connection not found: ${id}`);
    }

    const newId = crypto.randomUUID();
    const newConfig: ConnectionConfig = {
      ...existing,
      id: newId,
      name: `${existing.name} (Copy)`
    };

    const secrets = await this.getSecrets(id);
    await this.saveConnection(newConfig, secrets);
  }

  public async getSecrets(id: string): Promise<ConnectionSecrets> {
    const secretStr = await this.context.secrets.get(SECRET_PREFIX + id);
    if (secretStr) {
      try {
        return JSON.parse(secretStr) as ConnectionSecrets;
      } catch (e) {
        return {};
      }
    }
    return {};
  }

  private persist(): Thenable<void> {
    return this.context.globalState.update(STORAGE_CONNECTIONS, this._connections);
  }

  public dispose(): void {
    this._onDidChangeConnections.dispose();
    this._onDidChangeActiveConnection.dispose();
  }
}
