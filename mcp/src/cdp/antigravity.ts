import { CdpConnection, discoverTargets, isAntigravityTarget, resolveAntigravityTarget } from './client';
import {
  isGenerationRunning,
  readLatestResponseText,
  waitForAntigravityCompletion,
} from './completion-monitor';
import {
  getCurrentModeWithConnection,
  getCurrentModelWithConnection,
  setModeWithConnection,
  setModelWithConnection,
} from './settings';
import { antigravityTaskQueue } from '../orchestration/task-queue';
import type { CdpTarget } from '../types';

const SAFE_CHAT_INPUT_SELECTORS = [
  '.antigravity-agent-side-panel div[role="combobox"][contenteditable="true"]',
  '.antigravity-agent-side-panel div[role="textbox"][contenteditable="true"]',
  '.antigravity-agent-side-panel div[role="textbox"]',
  '#conversation div[role="combobox"][contenteditable="true"]',
  '#conversation div[role="textbox"][contenteditable="true"]',
  '#conversation div[role="textbox"]',
  '.antigravity-agent-side-panel div[contenteditable="true"]',
  '#conversation div[contenteditable="true"]',
];

const ALWAYS_EXCLUDED = [
  '.xterm',
  '.xterm-helper-textarea',
  '[aria-hidden="true"]',
  '.monaco-editor',
  '.native-edit-context',
  '.inputarea',
].join(',');

async function withTarget<T>(
  targetId: string | undefined,
  workspacePath: string | undefined,
  action: (cdp: CdpConnection, target: CdpTarget) => Promise<T>,
): Promise<T> {
  const target = await resolveAntigravityTarget(targetId, workspacePath);
  const cdp = new CdpConnection(target);
  await cdp.connect();
  try {
    return await action(cdp, target);
  } finally {
    cdp.close();
  }
}

function contextCandidates(cdp: CdpConnection): Array<number | undefined> {
  return [undefined, ...cdp.getContextIds()];
}

async function focusSafeChatInput(cdp: CdpConnection): Promise<{ selector: string; contextId?: number }> {
  for (const selector of SAFE_CHAT_INPUT_SELECTORS) {
    const expression = `(() => {
      const selector = ${JSON.stringify(selector)};
      const excluded = ${JSON.stringify(ALWAYS_EXCLUDED)};
      const nodes = Array.from(document.querySelectorAll(selector));
      const visible = nodes.filter((el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (el.closest(excluded)) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width >= 40 && rect.height >= 8 && style.display !== 'none' && style.visibility !== 'hidden';
      });
      const el = visible[visible.length - 1];
      if (!el) return false;
      document.querySelectorAll('[data-remoat-mcp-chat-input="1"]').forEach((node) => node.removeAttribute('data-remoat-mcp-chat-input'));
      el.setAttribute('data-remoat-mcp-chat-input', '1');
      el.focus();
      return document.activeElement === el;
    })()`;

    for (const contextId of contextCandidates(cdp)) {
      try {
        const ok = await cdp.evaluate(expression, contextId);
        if (ok === true) return { selector, contextId };
      } catch {
        // Context may belong to another frame/webview or may have been destroyed.
      }
    }
  }

  throw new Error('Safe Antigravity chat input not found. Refusing to type into an unscoped editor.');
}

async function verifyFocusedInput(cdp: CdpConnection, contextId?: number): Promise<void> {
  const expression = `(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) return false;
    if (el.getAttribute('data-remoat-mcp-chat-input') !== '1') return false;
    if (el.closest(${JSON.stringify(ALWAYS_EXCLUDED)})) return false;
    return true;
  })()`;
  const ok = await cdp.evaluate(expression, contextId);
  if (ok !== true) throw new Error('Chat input focus verification failed. Prompt was not sent.');
}

async function clearFocusedInput(cdp: CdpConnection): Promise<void> {
  const isMac = process.platform === 'darwin';
  const modifiers = isMac ? 4 : 2;
  const modifierKey = isMac ? 'Meta' : 'Control';
  const modifierCode = isMac ? 'MetaLeft' : 'ControlLeft';

  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: modifierKey, code: modifierCode, modifiers });
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers,
  });
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers,
  });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: modifierKey, code: modifierCode });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
}

export async function getStatus(): Promise<Record<string, unknown>> {
  const targets = await discoverTargets();
  const antigravityTargets = targets.filter(isAntigravityTarget);
  return {
    connected: antigravityTargets.length > 0,
    targetCount: antigravityTargets.length,
    targets: antigravityTargets.map((target) => ({
      id: target.id,
      title: target.title ?? '',
      url: target.url ?? '',
      port: target.port,
    })),
  };
}

export async function listTargets(): Promise<Array<Record<string, unknown>>> {
  const targets = await discoverTargets();
  return targets
    .filter((target) => target.webSocketDebuggerUrl)
    .map((target) => ({
      id: target.id,
      title: target.title ?? '',
      url: target.url ?? '',
      type: target.type ?? '',
      port: target.port,
      antigravity: isAntigravityTarget(target),
    }));
}

async function sendPromptWithConnection(cdp: CdpConnection, prompt: string): Promise<{ selector: string }> {
  const focused = await focusSafeChatInput(cdp);
  await verifyFocusedInput(cdp, focused.contextId);
  await clearFocusedInput(cdp);
  await verifyFocusedInput(cdp, focused.contextId);
  await cdp.call('Input.insertText', { text: prompt });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  return { selector: focused.selector };
}

export async function sendPrompt(prompt: string, targetId?: string, workspacePath?: string): Promise<Record<string, unknown>> {
  if (!prompt.trim()) throw new Error('Prompt must not be empty.');
  const target = await resolveAntigravityTarget(targetId, workspacePath);
  const queueKey = `target:${target.id}`;
  const queue = antigravityTaskQueue.snapshot(queueKey);
  if (queue.running || queue.pending > 0) {
    throw new Error('Antigravity target is busy in the Remoat MCP queue. Use run_antigravity_task so the request is serialized safely.');
  }

  return await withTarget(target.id, workspacePath, async (cdp, exactTarget) => {
    if (await isGenerationRunning(cdp)) {
      throw new Error('Antigravity is already generating. Refusing fire-and-forget injection into the native Antigravity queue; use run_antigravity_task instead.');
    }
    const sent = await sendPromptWithConnection(cdp, prompt);
    return {
      sent: true,
      asynchronous: true,
      targetId: exactTarget.id,
      targetTitle: exactTarget.title ?? '',
      selector: sent.selector,
      note: 'Prompt was submitted while the target was idle. Antigravity may still be working; use run_antigravity_task for synchronous completion.',
    };
  });
}

export async function runAntigravityTask(
  prompt: string,
  targetId?: string,
  timeoutSeconds = 600,
  model?: string,
  mode?: string,
  workspacePath?: string,
): Promise<Record<string, unknown>> {
  if (!prompt.trim()) throw new Error('Prompt must not be empty.');
  const boundedTimeoutSeconds = Math.min(900, Math.max(10, Math.floor(timeoutSeconds)));
  const initialTarget = await resolveAntigravityTarget(targetId, workspacePath);
  const queueKey = `target:${initialTarget.id}`;

  const queued = await antigravityTaskQueue.submit(queueKey, async () =>
    withTarget(initialTarget.id, workspacePath, async (cdp, target) => {
      let modelResult: Record<string, unknown> | undefined;
      let modeResult: Record<string, unknown> | undefined;
      if (model?.trim()) modelResult = await setModelWithConnection(cdp, model);
      if (mode?.trim()) modeResult = await setModeWithConnection(cdp, mode);

      const baselineText = await readLatestResponseText(cdp);
      const sent = await sendPromptWithConnection(cdp, prompt);
      const completion = await waitForAntigravityCompletion(cdp, {
        baselineText,
        timeoutMs: boundedTimeoutSeconds * 1000,
        pollIntervalMs: 1500,
        stablePollCount: 3,
      });

      return {
        sent: true,
        completed: completion.completed,
        timedOut: completion.timedOut,
        generationStarted: completion.generationStarted,
        targetId: target.id,
        targetTitle: target.title ?? '',
        selector: sent.selector,
        elapsedMs: completion.elapsedMs,
        polls: completion.polls,
        text: completion.text,
        model: modelResult?.model ?? await getCurrentModelWithConnection(cdp),
        mode: modeResult?.mode ?? await getCurrentModeWithConnection(cdp),
      };
    }),
  );

  return {
    ...queued.value,
    queue: queued.queue,
  };
}

export async function getTaskQueueStatus(targetId?: string, workspacePath?: string): Promise<Record<string, unknown>> {
  const target = await resolveAntigravityTarget(targetId, workspacePath);
  const key = `target:${target.id}`;
  return {
    targetId: target.id,
    targetTitle: target.title ?? '',
    ...antigravityTaskQueue.snapshot(key),
  };
}

export async function getLatestResponse(targetId?: string, workspacePath?: string): Promise<Record<string, unknown>> {
  return await withTarget(targetId, workspacePath, async (cdp, target) => {
    const text = await readLatestResponseText(cdp);
    return {
      targetId: target.id,
      targetTitle: target.title ?? '',
      text,
      empty: text.length === 0,
    };
  });
}

export async function stopGeneration(targetId?: string, workspacePath?: string): Promise<Record<string, unknown>> {
  return await withTarget(targetId, workspacePath, async (cdp, target) => {
    const expression = `(() => {
      const primary = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
      if (primary instanceof HTMLElement) { primary.click(); return true; }
      const patterns = /^(stop|stop generating|stop response|停止|生成を停止|応答を停止)$/i;
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const button = buttons.find((node) => patterns.test((node.textContent || '').trim()));
      if (button instanceof HTMLElement) { button.click(); return true; }
      return false;
    })()`;

    for (const contextId of contextCandidates(cdp)) {
      try {
        const stopped = await cdp.evaluate(expression, contextId);
        if (stopped === true) return { stopped: true, targetId: target.id };
      } catch {
        // Ignore unrelated execution contexts.
      }
    }
    return { stopped: false, targetId: target.id, reason: 'Stop control not found; Antigravity may already be idle.' };
  });
}

export async function captureScreenshot(targetId?: string, workspacePath?: string): Promise<{ data: string; targetId: string }> {
  return await withTarget(targetId, workspacePath, async (cdp, target) => {
    await cdp.call('Page.enable');
    const result = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    if (typeof result?.data !== 'string') throw new Error('Antigravity did not return screenshot data.');
    return { data: result.data, targetId: target.id };
  });
}
