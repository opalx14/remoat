import { homedir } from 'node:os';
import path from 'node:path';

export interface HttpConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  ownerPassword: string;
  stateDir: string;
  trustProxy: boolean;
  oauth: {
    scopes: string[];
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    allowedRedirectHosts: string[];
  };
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function intEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function boolEnv(name: string, fallback = false): boolean {
  const raw = env(name)?.toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be a boolean value.`);
}

export function loadHttpConfig(): HttpConfig {
  const host = env('REMOAT_MCP_HOST') ?? '127.0.0.1';
  const port = intEnv('REMOAT_MCP_PORT', 7680);
  const publicBaseUrl = (env('REMOAT_MCP_PUBLIC_URL') ?? `http://${host}:${port}`).replace(/\/+$/, '');
  const ownerPassword = env('REMOAT_MCP_OWNER_PASSWORD');

  if (!ownerPassword) {
    throw new Error(
      'REMOAT_MCP_OWNER_PASSWORD is required for HTTP mode. Generate a strong value and store it in mcp/.env.local.',
    );
  }

  let publicUrl: URL;
  try {
    publicUrl = new URL(publicBaseUrl);
  } catch {
    throw new Error('REMOAT_MCP_PUBLIC_URL must be a valid URL.');
  }

  if (publicUrl.protocol !== 'https:' && publicUrl.hostname !== '127.0.0.1' && publicUrl.hostname !== 'localhost') {
    throw new Error('REMOAT_MCP_PUBLIC_URL must use HTTPS unless it points to localhost.');
  }

  const redirectHosts = (env('REMOAT_MCP_ALLOWED_REDIRECT_HOSTS') ?? 'chatgpt.com,chat.openai.com')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return {
    host,
    port,
    publicBaseUrl,
    ownerPassword,
    stateDir: env('REMOAT_MCP_STATE_DIR') ?? path.join(homedir(), '.remoat-mcp'),
    trustProxy: boolEnv('REMOAT_MCP_TRUST_PROXY', true),
    oauth: {
      scopes: ['remoat'],
      accessTokenTtlSeconds: intEnv('REMOAT_MCP_ACCESS_TOKEN_TTL', 60 * 60),
      refreshTokenTtlSeconds: intEnv('REMOAT_MCP_REFRESH_TOKEN_TTL', 60 * 60 * 24 * 30),
      allowedRedirectHosts: redirectHosts,
    },
  };
}
