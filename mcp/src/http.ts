import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadHttpConfig } from './config';
import { SingleUserOAuthProvider } from './auth/provider';
import { createSdkServer } from './sdk-server';

function sendJsonRpcError(res: any, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

async function main(): Promise<void> {
  const config = loadHttpConfig();
  const publicUrl = new URL(config.publicBaseUrl);
  const allowedHosts = Array.from(
    new Set([
      config.host,
      '127.0.0.1',
      'localhost',
      publicUrl.hostname,
      publicUrl.host,
    ]),
  );

  const app = createMcpExpressApp({ host: config.host, allowedHosts });
  if (config.trustProxy) app.set('trust proxy', 1);

  const mcpUrl = new URL('/mcp', config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(
    {
      ownerPassword: config.ownerPassword,
      accessTokenTtlSeconds: config.oauth.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: config.oauth.refreshTokenTtlSeconds,
      scopes: config.oauth.scopes,
      allowedRedirectHosts: config.oauth.allowedRedirectHosts,
    },
    mcpUrl,
    config.stateDir,
  );

  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: config.oauth.scopes,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: 'Remoat MCP',
    }),
  );

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      name: 'remoat-antigravity-mcp',
      transport: 'streamable-http',
      publicBaseUrl: config.publicBaseUrl,
    });
  });

  app.all('/mcp', async (req, res) => {
    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    }).catch((reason) => {
      if (!res.headersSent) {
        console.error('[remoat-mcp] bearer auth failed:', reason instanceof Error ? reason.message : String(reason));
        sendJsonRpcError(res, 401, -32001, 'Unauthorized');
      }
    });

    if (res.headersSent) return;
    if (!req.auth?.resource || !oauthProvider.isResourceAllowed(req.auth.resource)) {
      sendJsonRpcError(res, 401, -32001, 'Unauthorized');
      return;
    }

    const server = createSdkServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (reason) {
      console.error('[remoat-mcp] MCP request failed:', reason);
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, 'Internal server error');
    } finally {
      if (!res.headersSent || res.writableEnded) {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      } else {
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
      }
    }
  });

  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`[remoat-mcp] Local MCP: http://${config.host}:${config.port}/mcp`);
    console.log(`[remoat-mcp] Public MCP: ${config.publicBaseUrl}/mcp`);
    console.log(`[remoat-mcp] OAuth authorize: ${config.publicBaseUrl}/authorize`);
  });

  const shutdown = () => {
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((reason) => {
  console.error('[remoat-mcp] failed to start:', reason instanceof Error ? reason.stack ?? reason.message : String(reason));
  process.exit(1);
});
