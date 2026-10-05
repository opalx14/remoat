import { createHash, randomBytes } from 'node:crypto';

const baseUrl = (process.env.REMOAT_MCP_PUBLIC_URL ?? 'https://remoat.promptmarketcap.net').replace(/\/+$/, '');
const ownerPassword = process.env.REMOAT_MCP_OWNER_PASSWORD;
if (!ownerPassword) throw new Error('REMOAT_MCP_OWNER_PASSWORD is required.');

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const resource = `${baseUrl}/mcp`;

async function jsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  if (!text) return {};

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    if (dataLines.length === 0) throw new Error(`SSE response did not contain data: ${text}`);
    return JSON.parse(dataLines[dataLines.length - 1]);
  }

  return JSON.parse(text);
}

const registration = await jsonResponse(
  await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Remoat MCP smoke test',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  }),
);

const authParams = new URLSearchParams({
  response_type: 'code',
  client_id: registration.client_id,
  redirect_uri: redirectUri,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  scope: 'remoat',
  resource,
  state: 'smoke-test',
});

const authorizeUrl = `${baseUrl}/authorize?${authParams}`;
const authorizePage = await fetch(authorizeUrl, { redirect: 'manual' });
if (authorizePage.status !== 200) {
  throw new Error(`authorize GET expected 200, got ${authorizePage.status}`);
}
const pageText = await authorizePage.text();
if (!pageText.includes('Connect Remoat MCP')) throw new Error('Owner approval page was not returned.');

const approvalBody = new URLSearchParams(authParams);
approvalBody.set('owner_token', ownerPassword);
const approval = await fetch(`${baseUrl}/authorize`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: approvalBody,
  redirect: 'manual',
});
if (approval.status !== 302) throw new Error(`authorize POST expected 302, got ${approval.status}`);
const location = approval.headers.get('location');
if (!location) throw new Error('authorize POST did not return a redirect location.');
const code = new URL(location).searchParams.get('code');
if (!code) throw new Error('authorization redirect did not contain code.');

const token = await jsonResponse(
  await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: registration.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  }),
);

if (!token.access_token || !token.refresh_token) throw new Error('OAuth token endpoint did not return access + refresh tokens.');

async function mcp(body: unknown): Promise<any> {
  return jsonResponse(
    await fetch(resource, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    }),
  );
}

const initialized = await mcp({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'remoat-smoke-test', version: '1.0.0' },
  },
});
if (!initialized.result?.serverInfo?.name) throw new Error('MCP initialize failed.');

const toolList = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const toolNames = (toolList.result?.tools ?? []).map((tool: any) => tool.name);
if (
  !toolNames.includes('antigravity_status') ||
  !toolNames.includes('run_antigravity_task') ||
  !toolNames.includes('antigravity_queue_status') ||
  !toolNames.includes('list_models') ||
  !toolNames.includes('get_model') ||
  !toolNames.includes('set_model') ||
  !toolNames.includes('send_prompt')
) {
  throw new Error(`Unexpected MCP tool list: ${toolNames.join(', ')}`);
}

const statusCall = await mcp({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'antigravity_status', arguments: {} },
});
const statusText = statusCall.result?.content?.find((item: any) => item.type === 'text')?.text;
if (!statusText) throw new Error('antigravity_status did not return text content.');
const antigravityStatus = JSON.parse(statusText);
if (antigravityStatus.connected !== true) throw new Error('Antigravity is not reachable through the remote MCP path.');

const firstTargetId = antigravityStatus.targets?.[0]?.id;
let modelReadable = false;
if (firstTargetId) {
  const modelCall = await mcp({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'get_model', arguments: { targetId: firstTargetId } },
  });
  const modelText = modelCall.result?.content?.find((item: any) => item.type === 'text')?.text;
  if (modelText) {
    const parsedModel = JSON.parse(modelText);
    modelReadable = typeof parsedModel.model === 'string' && parsedModel.model.length > 0;
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      oauth: { registration: true, approval: true, accessToken: true, refreshToken: true },
      mcp: { initialize: true, tools: toolNames, modelReadable },
    },
    null,
    2,
  ),
);
