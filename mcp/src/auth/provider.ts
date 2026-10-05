import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import { JsonOAuthClientsStore, JsonOAuthStore } from './store';

interface OAuthConfig {
  ownerPassword: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  scopes: string[];
  allowedRedirectHosts: string[];
}

interface AuthorizationCodeRecord {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
}

const CODE_TTL_MS = 5 * 60 * 1000;

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function safeEquals(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function authorizationFormFields(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): Record<string, string | undefined> {
  return {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    scope: params.scopes?.join(' '),
    state: params.state,
    resource: params.resource?.href,
  };
}

function approvalHtml(params: {
  error?: string;
  clientName: string;
  scopes: string[];
  resource?: URL;
  fields: Record<string, string | undefined>;
}): string {
  const hiddenFields = Object.entries(params.fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}" />`)
    .join('\n');
  const error = params.error ? `<p class="error">${htmlEscape(params.error)}</p>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Connect Remoat MCP</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;margin:0}
main{max-width:460px;margin:10vh auto;padding:32px;background:#111827;border:1px solid #334155;border-radius:18px}
h1{margin-top:0}p{line-height:1.5;color:#cbd5e1}.warning{color:#fde68a}.error{color:#fecaca;background:#7f1d1d;padding:10px;border-radius:8px}
dl{padding:16px;background:#020617;border-radius:12px}dt{font-size:12px;color:#94a3b8;text-transform:uppercase}dd{margin:4px 0 12px;word-break:break-word}
label{display:block;margin:18px 0 8px;font-weight:600}input{box-sizing:border-box;width:100%;padding:12px;border-radius:10px;border:1px solid #475569;background:#020617;color:#e2e8f0;font-size:16px}button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:10px;font-weight:700;cursor:pointer}
</style>
</head>
<body><main>
<h1>Connect Remoat MCP</h1>
<p class="warning">Approve only when you are intentionally connecting your own ChatGPT client to this Mac and Antigravity instance.</p>
${error}
<dl><dt>Client</dt><dd>${htmlEscape(params.clientName)}</dd><dt>Scope</dt><dd>${htmlEscape(params.scopes.join(' '))}</dd><dt>Resource</dt><dd>${htmlEscape(params.resource?.href ?? 'Remoat MCP')}</dd></dl>
<form method="post">${hiddenFields}<label for="owner_token">Owner password</label><input id="owner_token" name="owner_token" type="password" autocomplete="current-password" required autofocus /><button type="submit">Authorize Remoat MCP</button></form>
</main></body></html>`;
}

function sameResource(left: URL, right: URL): boolean {
  return resourceUrlFromServerUrl(left).href === resourceUrlFromServerUrl(right).href;
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly store: JsonOAuthStore;
  private readonly resourceServerUrl: URL;

  constructor(
    private readonly config: OAuthConfig,
    resourceServerUrl: URL,
    stateDir: string,
  ) {
    this.resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    this.store = new JsonOAuthStore(stateDir);
    this.clientsStore = new JsonOAuthClientsStore(this.store, config.allowedRedirectHosts);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (!params.resource || !this.isResourceAllowed(params.resource)) {
      throw new InvalidRequestError('Invalid or missing OAuth resource');
    }
    if (!(params.scopes ?? []).every((scope) => this.config.scopes.includes(scope))) {
      throw new InvalidRequestError('Requested scope is not supported');
    }

    if (res.req.method !== 'POST') {
      res.status(200).type('html').send(
        approvalHtml({
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: authorizationFormFields(client, params),
        }),
      );
      return;
    }

    const provided = String(res.req.body?.owner_token ?? '');
    if (!safeEquals(provided, this.config.ownerPassword)) {
      res.status(401).type('html').send(
        approvalHtml({
          error: 'Owner password was not accepted.',
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: authorizationFormFields(client, params),
        }),
      );
      return;
    }

    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      clientId: client.client_id,
      params,
      expiresAtMs: Date.now() + CODE_TTL_MS,
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (params.state !== undefined) redirectUrl.searchParams.set('state', params.state);
    res.redirect(302, redirectUrl.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this.validCodeRecord(client, authorizationCode).params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.validCodeRecord(client, authorizationCode);
    if (redirectUri && redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match authorization request');
    }
    if (resource && (!record.params.resource || !sameResource(resource, record.params.resource))) {
      throw new InvalidGrantError('Invalid resource');
    }

    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id, record.params.scopes ?? this.config.scopes, record.params.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const refreshTokenHash = hashToken(refreshToken);
    const record = this.store.getRefreshToken(refreshTokenHash);
    if (!record || record.clientId !== client.client_id || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError('Invalid refresh token');
    }
    const recordedResource = record.resource ? new URL(record.resource) : undefined;
    if (!recordedResource || !this.isResourceAllowed(recordedResource)) {
      throw new InvalidGrantError('Invalid resource');
    }
    if (resource && !sameResource(resource, recordedResource)) {
      throw new InvalidGrantError('Invalid resource');
    }

    const requestedScopes = scopes ?? record.scopes;
    if (!requestedScopes.every((scope) => record.scopes.includes(scope))) {
      throw new AccessDeniedError('Refresh token cannot grant requested scopes');
    }

    return this.issueTokens(client.client_id, requestedScopes, resource ?? recordedResource, refreshTokenHash);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.getAccessToken(hashToken(token));
    if (!record || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidTokenError('Invalid or expired access token');
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource ? new URL(record.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hashed = hashToken(request.token);
    this.store.deleteAccessToken(hashed);
    this.store.deleteRefreshToken(hashed);
  }

  isResourceAllowed(resource: URL): boolean {
    return checkResourceAllowed({
      requestedResource: resource,
      configuredResource: this.resourceServerUrl,
    });
  }

  private validCodeRecord(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): AuthorizationCodeRecord {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs < Date.now()) {
      throw new InvalidGrantError('Invalid authorization code');
    }
    return record;
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    resource?: URL,
    consumedRefreshTokenHash?: string,
  ): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpiresAt = now + this.config.accessTokenTtlSeconds;
    const refreshExpiresAt = now + this.config.refreshTokenTtlSeconds;

    const saved = this.store.saveTokenPair(
      {
        accessTokenHash: hashToken(accessToken),
        accessToken: { clientId, scopes, expiresAt: accessExpiresAt, resource: resource?.href },
        refreshTokenHash: hashToken(refreshToken),
        refreshToken: { clientId, scopes, expiresAt: refreshExpiresAt, resource: resource?.href },
      },
      consumedRefreshTokenHash,
    );
    if (!saved) throw new InvalidGrantError('Invalid refresh token');

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }
}
