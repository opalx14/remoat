import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { callTool } from './tools';
import type { ToolCallResult } from './types';

const SERVER_INFO = {
  name: 'remoat-antigravity-mcp',
  version: '0.4.0',
};

function result(value: ToolCallResult) {
  return value as any;
}

const projectRoutingSchema = {
  workspacePath: z.string().min(1).optional().describe(
    'Full project workspace path. Preferred routing key: if the project is not open, Remoat launches Antigravity for this exact path and waits for the matching workbench.',
  ),
  targetId: z.string().min(1).optional().describe(
    'Optional exact CDP target id. When workspacePath is also provided, the target must belong to that project or the call is refused.',
  ),
};

export function createSdkServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Control the local Antigravity IDE through CDP. Prefer workspacePath as the project routing key: if that workspace is not open, Remoat launches Antigravity for the exact path and waits for its matching workbench. Never fall back to another open project. targetId remains an optional exact override and must match workspacePath when both are supplied. For normal work MUST prefer run_antigravity_task: it serializes tasks per target, applies optional model/mode inside the lock, waits for Antigravity to finish, and returns the final response.',
  });

  server.registerTool(
    'antigravity_status',
    {
      description: 'Check whether Antigravity is reachable through CDP and list detected Antigravity workbench targets.',
      inputSchema: {},
    },
    async () => result(await callTool('antigravity_status')),
  );

  server.registerTool(
    'list_antigravity_targets',
    {
      description: 'List CDP targets exposed by Antigravity debug ports. Use this for diagnosis or to obtain an exact targetId.',
      inputSchema: {},
    },
    async () => result(await callTool('list_antigravity_targets')),
  );

  server.registerTool(
    'run_antigravity_task',
    {
      description:
        'Preferred tool for normal work: route by workspacePath, auto-open the requested Antigravity project when needed, serialize by target, optionally select model/mode, send a prompt, wait for generation to finish and return the final response.',
      inputSchema: {
        prompt: z.string().min(1).describe('Prompt to send to Antigravity.'),
        ...projectRoutingSchema,
        timeoutSeconds: z.number().min(10).max(900).optional().describe('Maximum execution time after this task reaches the front of the queue. Defaults to 600 seconds.'),
        model: z.string().min(1).optional().describe('Optional model to select before sending this task.'),
        mode: z.enum(['fast', 'plan', 'planning']).optional().describe('Optional execution mode to select before sending this task.'),
      },
    },
    async ({ prompt, workspacePath, targetId, timeoutSeconds, model, mode }) =>
      result(await callTool('run_antigravity_task', { prompt, workspacePath, targetId, timeoutSeconds, model, mode })),
  );

  server.registerTool(
    'antigravity_queue_status',
    {
      description: 'Read the Remoat MCP per-target queue for the requested project/target.',
      inputSchema: projectRoutingSchema,
    },
    async ({ workspacePath, targetId }) => result(await callTool('antigravity_queue_status', { workspacePath, targetId })),
  );

  server.registerTool(
    'list_models',
    {
      description: 'List models exposed by the selected Antigravity project.',
      inputSchema: projectRoutingSchema,
    },
    async ({ workspacePath, targetId }) => result(await callTool('list_models', { workspacePath, targetId })),
  );

  server.registerTool(
    'get_model',
    {
      description: 'Read the currently selected Antigravity model for a project/target.',
      inputSchema: projectRoutingSchema,
    },
    async ({ workspacePath, targetId }) => result(await callTool('get_model', { workspacePath, targetId })),
  );

  server.registerTool(
    'set_model',
    {
      description: 'Set the Antigravity model, serialized through the same target queue used for tasks.',
      inputSchema: {
        model: z.string().min(1).describe('Model name, preferably from list_models.'),
        ...projectRoutingSchema,
      },
    },
    async ({ model, workspacePath, targetId }) => result(await callTool('set_model', { model, workspacePath, targetId })),
  );

  server.registerTool(
    'get_mode',
    {
      description: 'Read the legacy Fast/Planning execution mode for a project/target when the UI exposes that toggle.',
      inputSchema: projectRoutingSchema,
    },
    async ({ workspacePath, targetId }) => result(await callTool('get_mode', { workspacePath, targetId })),
  );

  server.registerTool(
    'set_mode',
    {
      description: 'Set legacy Antigravity Fast/Planning mode when supported, serialized through the per-target queue.',
      inputSchema: {
        mode: z.enum(['fast', 'plan', 'planning']),
        ...projectRoutingSchema,
      },
    },
    async ({ mode, workspacePath, targetId }) => result(await callTool('set_mode', { mode, workspacePath, targetId })),
  );

  server.registerTool(
    'send_prompt',
    {
      description:
        'Fire-and-forget write action for the requested project. Prefer run_antigravity_task for normal work so ChatGPT waits for completion.',
      inputSchema: {
        prompt: z.string().min(1).describe('Prompt to send to Antigravity.'),
        ...projectRoutingSchema,
      },
    },
    async ({ prompt, workspacePath, targetId }) => result(await callTool('send_prompt', { prompt, workspacePath, targetId })),
  );

  server.registerTool(
    'get_latest_response',
    {
      description: 'Read the latest visible assistant response from a selected Antigravity project/target.',
      inputSchema: projectRoutingSchema,
    },
    async ({ workspacePath, targetId }) => result(await callTool('get_latest_response', { workspacePath, targetId })),
  );

  server.registerTool(
    'stop_generation',
    {
      description: 'Stop the active generation for a selected Antigravity project/target.',
      inputSchema: projectRoutingSchema,
    },
    async ({ workspacePath, targetId }) => result(await callTool('stop_generation', { workspacePath, targetId })),
  );

  server.registerTool(
    'screenshot_antigravity',
    {
      description: 'Capture a selected Antigravity project/target as a PNG image.',
      inputSchema: projectRoutingSchema,
    },
    async ({ workspacePath, targetId }) => result(await callTool('screenshot_antigravity', { workspacePath, targetId })),
  );

  return server;
}
