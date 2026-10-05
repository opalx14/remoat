import {
  captureScreenshot,
  getLatestResponse,
  getStatus,
  getTaskQueueStatus,
  listTargets,
  runAntigravityTask,
  sendPrompt,
  stopGeneration,
} from '../cdp/antigravity';
import {
  getCurrentMode,
  getCurrentModel,
  listModels,
  setCurrentMode,
  setCurrentModel,
} from '../cdp/settings';
import type { ToolCallResult, ToolDefinition } from '../types';

export const tools: ToolDefinition[] = [
  {
    name: 'antigravity_status',
    description: 'Check whether Antigravity is reachable through CDP and list detected Antigravity workbench targets.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_antigravity_targets',
    description: 'List CDP targets exposed by the configured Antigravity debug ports. When multiple Antigravity workbenches are open, copy the intended workbench id and pass it as targetId to every project-scoped tool call.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_antigravity_task',
    description: 'Preferred tool for normal work. Serialize by Antigravity target, optionally set model/mode for this task, send the prompt, wait until generation completes, then return the final response.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, description: 'Prompt to send to Antigravity.' },
        workspacePath: { type: 'string', description: 'Full project workspace path. Preferred routing key: auto-opens Antigravity for this project when needed.' },
        targetId: { type: 'string', description: 'Optional exact CDP target id. When workspacePath is also provided, the target must match that project.' },
        timeoutSeconds: { type: 'number', minimum: 10, maximum: 900, description: 'Maximum execution time after the task reaches the front of the queue. Defaults to 600 seconds.' },
        model: { type: 'string', description: 'Optional Antigravity model to select for this task before sending the prompt.' },
        mode: { type: 'string', enum: ['fast', 'plan', 'planning'], description: 'Optional Antigravity execution mode for this task.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'antigravity_queue_status',
    description: 'Read the Remoat MCP queue state for the selected project/target. workspacePath can auto-open the requested Antigravity project before resolving its target.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string', description: 'Full project workspace path.' },
        targetId: { type: 'string', description: 'Optional exact CDP target id; must match workspacePath when both are provided.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_models',
    description: 'List models currently exposed by the selected Antigravity project.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string', description: 'Full project workspace path.' },
        targetId: { type: 'string', description: 'Optional exact CDP target id; must match workspacePath when both are provided.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_model',
    description: 'Read the currently selected Antigravity model for a project/target.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string', description: 'Full project workspace path.' },
        targetId: { type: 'string', description: 'Optional exact CDP target id; must match workspacePath when both are provided.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_model',
    description: 'Set the Antigravity model. This mutation is serialized through the same per-target queue as run_antigravity_task.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', minLength: 1, description: 'Model name, preferably from list_models.' },
        workspacePath: { type: 'string', description: 'Full project workspace path.' },
        targetId: { type: 'string', description: 'Optional exact CDP target id; must match workspacePath when both are provided.' },
      },
      required: ['model'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_mode',
    description: 'Read the legacy Fast/Planning execution mode for a project/target when supported.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string', description: 'Full project workspace path.' },
        targetId: { type: 'string', description: 'Optional exact CDP target id; must match workspacePath when both are provided.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_mode',
    description: 'Set legacy Antigravity Fast/Planning mode when supported by the current UI. This mutation is serialized through the per-target queue.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'plan', 'planning'] },
        workspacePath: { type: 'string', description: 'Full project workspace path.' },
        targetId: { type: 'string', description: 'Optional exact CDP target id; must match workspacePath when both are provided.' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_prompt',
    description: 'Fire-and-forget: submit a prompt to Antigravity and return immediately without waiting for completion. Prefer run_antigravity_task for normal work.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, description: 'Prompt to send to Antigravity.' },
        workspacePath: { type: 'string', description: 'Full project workspace path. Auto-opens Antigravity for this project when needed.' },
        targetId: { type: 'string', description: 'Optional exact CDP target id; must match workspacePath when both are provided.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_latest_response',
    description: 'Read the latest visible assistant response from a selected Antigravity project/target.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string', description: 'Full project workspace path.' },
        targetId: { type: 'string', description: 'Optional exact CDP target id; must match workspacePath when both are provided.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'stop_generation',
    description: 'Stop the active generation for a selected Antigravity project/target.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string', description: 'Full project workspace path.' },
        targetId: { type: 'string', description: 'Optional exact CDP target id; must match workspacePath when both are provided.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot_antigravity',
    description: 'Capture a selected Antigravity project/target as a PNG image.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string', description: 'Full project workspace path.' },
        targetId: { type: 'string', description: 'Optional exact CDP target id; must match workspacePath when both are provided.' },
      },
      additionalProperties: false,
    },
  },
];

function textResult(value: unknown): ToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function optionalTargetId(args: Record<string, unknown>): string | undefined {
  const value = args.targetId;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error('targetId must be a non-empty string when provided.');
  return value.trim();
}

function optionalWorkspacePath(args: Record<string, unknown>): string | undefined {
  const value = args.workspacePath;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error('workspacePath must be a non-empty string when provided.');
  return value.trim();
}

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  switch (name) {
    case 'antigravity_status':
      return textResult(await getStatus());
    case 'list_antigravity_targets':
      return textResult(await listTargets());
    case 'run_antigravity_task': {
      const prompt = args.prompt;
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required and must be a non-empty string.');
      const timeoutSeconds = args.timeoutSeconds === undefined ? 600 : Number(args.timeoutSeconds);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 900) {
        throw new Error('timeoutSeconds must be a number between 10 and 900.');
      }
      const model = args.model === undefined ? undefined : String(args.model).trim();
      const mode = args.mode === undefined ? undefined : String(args.mode).trim();
      return textResult(await runAntigravityTask(prompt, optionalTargetId(args), timeoutSeconds, model, mode, optionalWorkspacePath(args)));
    }
    case 'antigravity_queue_status':
      return textResult(await getTaskQueueStatus(optionalTargetId(args), optionalWorkspacePath(args)));
    case 'list_models':
      return textResult(await listModels(optionalTargetId(args), optionalWorkspacePath(args)));
    case 'get_model':
      return textResult(await getCurrentModel(optionalTargetId(args), optionalWorkspacePath(args)));
    case 'set_model': {
      const model = args.model;
      if (typeof model !== 'string' || !model.trim()) throw new Error('model is required and must be a non-empty string.');
      return textResult(await setCurrentModel(model, optionalTargetId(args), optionalWorkspacePath(args)));
    }
    case 'get_mode':
      return textResult(await getCurrentMode(optionalTargetId(args), optionalWorkspacePath(args)));
    case 'set_mode': {
      const mode = args.mode;
      if (typeof mode !== 'string' || !mode.trim()) throw new Error('mode is required and must be a non-empty string.');
      return textResult(await setCurrentMode(mode, optionalTargetId(args), optionalWorkspacePath(args)));
    }
    case 'send_prompt': {
      const prompt = args.prompt;
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required and must be a non-empty string.');
      return textResult(await sendPrompt(prompt, optionalTargetId(args), optionalWorkspacePath(args)));
    }
    case 'get_latest_response':
      return textResult(await getLatestResponse(optionalTargetId(args), optionalWorkspacePath(args)));
    case 'stop_generation':
      return textResult(await stopGeneration(optionalTargetId(args), optionalWorkspacePath(args)));
    case 'screenshot_antigravity': {
      const screenshot = await captureScreenshot(optionalTargetId(args), optionalWorkspacePath(args));
      return {
        content: [
          { type: 'image', data: screenshot.data, mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify({ targetId: screenshot.targetId }, null, 2) },
        ],
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
