import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

interface AccessTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

interface RefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

interface PersistedState {
  clients: Record<string, OAuthClientInformationFull>;
  accessTokens: Record<string, AccessTokenRecord>;
  refreshTokens: Record<string, RefreshTokenRecord>;
}

const EMPTY_STATE: PersistedState = {
  clients: {},
  accessTokens: {},
  refreshTokens: {},
};

function cloneEmptyState(): PersistedState {
  return JSON.parse(JSON.stringify(EMPTY_STATE)) as PersistedState;
}

function redirectHostAllowed(redirectUri: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return true;
  const hostname = parsed.hostname.toLowerCase();
  return allowedHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

export class JsonOAuthStore {
  private readonly filePath: string;
  private state: PersistedState;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.filePath = path.join(stateDir, 'oauth-state.json');
    this.state = this.load();
    this.deleteExpiredTokens(Math.floor(Date.now() / 1000));
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.state.clients[clientId];
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
    allowedRedirectHosts: string[],
  ): OAuthClientInformationFull {
    if (!client.redirect_uris.every((uri) => redirectHostAllowed(String(uri), allowedRedirectHosts))) {
      throw new InvalidRequestError('Client redirect_uri is not allowed for this Remoat MCP server');
    }

    const now = Math.floor(Date.now() / 1000);
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: `remoat-${randomUUID()}`,
      client_id_issued_at: now,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? 'none',
      grant_types: client.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: client.response_types ?? ['code'],
    };

    this.state.clients[registered.client_id] = registered;
    this.persist();
    return registered;
  }

  getAccessToken(tokenHash: string): AccessTokenRecord | undefined {
    return this.state.accessTokens[tokenHash];
  }

  getRefreshToken(tokenHash: string): RefreshTokenRecord | undefined {
    return this.state.refreshTokens[tokenHash];
  }

  saveTokenPair(
    pair: {
      accessTokenHash: string;
      accessToken: AccessTokenRecord;
      refreshTokenHash: string;
      refreshToken: RefreshTokenRecord;
    },
    consumedRefreshTokenHash?: string,
  ): boolean {
    if (consumedRefreshTokenHash) {
      if (!this.state.refreshTokens[consumedRefreshTokenHash]) return false;
      delete this.state.refreshTokens[consumedRefreshTokenHash];
    }

    this.state.accessTokens[pair.accessTokenHash] = pair.accessToken;
    this.state.refreshTokens[pair.refreshTokenHash] = pair.refreshToken;
    this.persist();
    return true;
  }

  deleteAccessToken(tokenHash: string): void {
    delete this.state.accessTokens[tokenHash];
    this.persist();
  }

  deleteRefreshToken(tokenHash: string): void {
    delete this.state.refreshTokens[tokenHash];
    this.persist();
  }

  private load(): PersistedState {
    if (!fs.existsSync(this.filePath)) return cloneEmptyState();
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as PersistedState;
    } catch {
      return cloneEmptyState();
    }
  }

  private deleteExpiredTokens(now: number): void {
    for (const [hash, record] of Object.entries(this.state.accessTokens)) {
      if (record.expiresAt < now) delete this.state.accessTokens[hash];
    }
    for (const [hash, record] of Object.entries(this.state.refreshTokens)) {
      if (record.expiresAt < now) delete this.state.refreshTokens[hash];
    }
    this.persist();
  }

  private persist(): void {
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }
}

export class JsonOAuthClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly store: JsonOAuthStore,
    private readonly allowedRedirectHosts: string[],
  ) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.store.getClient(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    return this.store.registerClient(client, this.allowedRedirectHosts);
  }
}
