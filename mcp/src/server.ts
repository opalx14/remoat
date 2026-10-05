import readline from 'node:readline';
import { callTool, tools } from './tools';
import type { JsonRpcRequest, ToolCallResult } from './types';

const SERVER_INFO = {
  name: 'remoat-antigravity-mcp',
  version: '0.4.0',
};

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function success(id: JsonRpcRequest['id'], result: unknown): void {
  writeMessage({ jsonrpc: '2.0', id: id ?? null, result });
}

function error(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): void {
  writeMessage({
    jsonrpc: '2.0',
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  });
}

function toolError(reason: unknown): ToolCallResult {
  return {
    content: [
      {
        type: 'text',
        text: reason instanceof Error ? reason.message : String(reason),
      },
    ],
    isError: true,
  };
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  const { id, method, params = {} } = request;

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;

  if (method === 'initialize') {
    const requestedProtocol = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
    success(id, {
      protocolVersion: requestedProtocol,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: SERVER_INFO,
      instructions:
        'Control the local Antigravity IDE through Chrome DevTools Protocol. Prefer workspacePath as the project routing key: if the project is not open, Remoat launches Antigravity for the exact path, rescans CDP targets, and waits for the matching workbench. Never fall back to another open project. targetId is an optional exact override and must match workspacePath when both are supplied. For normal work MUST prefer run_antigravity_task so work is serialized per target and completion is returned safely.',
    });
    return;
  }

  if (method === 'ping') {
    success(id, {});
    return;
  }

  if (method === 'tools/list') {
    success(id, { tools });
    return;
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments;
    if (typeof name !== 'string' || !name) {
      error(id, -32602, 'tools/call requires params.name');
      return;
    }
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      error(id, -32602, 'tools/call params.arguments must be an object');
      return;
    }

    try {
      success(id, await callTool(name, (args ?? {}) as Record<string, unknown>));
    } catch (reason) {
      success(id, toolError(reason));
    }
    return;
  }

  if (id !== undefined) error(id, -32601, `Method not found: ${method}`);
}

export async function runStdioServer(): Promise<void> {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch (reason) {
      error(null, -32700, 'Parse error', reason instanceof Error ? reason.message : String(reason));
      continue;
    }

    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      error(request.id ?? null, -32600, 'Invalid Request');
      continue;
    }

    try {
      await handleRequest(request);
    } catch (reason) {
      error(request.id ?? null, -32603, 'Internal error', reason instanceof Error ? reason.message : String(reason));
    }
  }
}
