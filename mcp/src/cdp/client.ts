import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { CdpTarget } from '../types';

const DEFAULT_PORTS = [9222, 9223, 9333, 9444, 9555, 9666];

interface PendingCall {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export async function discoverTargets(ports = DEFAULT_PORTS): Promise<CdpTarget[]> {
  const targets: CdpTarget[] = [];

  await Promise.all(
    ports.map(async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(1200),
        });
        if (!response.ok) return;
        const list = (await response.json()) as Array<Omit<CdpTarget, 'port'>>;
        for (const target of list) {
          if (target.webSocketDebuggerUrl) targets.push({ ...target, port });
        }
      } catch {
        // Port is not serving CDP. Ignore it.
      }
    }),
  );

  return targets;
}

export function isAntigravityTarget(target: CdpTarget): boolean {
  const title = target.title ?? '';
  const url = target.url ?? '';
  if (!target.webSocketDebuggerUrl) return false;
  if (title.includes('Launchpad') || url.includes('workbench-jetski-agent')) return false;
  return (
    target.type === 'page' &&
    (url.includes('workbench') || title.includes('Antigravity') || title.includes('Cascade'))
  );
}

function describeTarget(target: CdpTarget): string {
  const title = (target.title ?? '').trim() || '(untitled)';
  return `id=${target.id} port=${target.port} title=${JSON.stringify(title)}`;
}

/**
 * Resolve one exact Antigravity workbench target.
 *
 * Safety invariant: when more than one Antigravity window is visible, never
 * guess which project the caller intended. The caller must pass targetId.
 */
export function selectAntigravityTarget(targets: CdpTarget[], targetId?: string): CdpTarget {
  const antigravityTargets = targets.filter(isAntigravityTarget);

  if (targetId) {
    const exact = targets.find((target) => target.id === targetId);
    if (!exact) throw new Error(`CDP target not found: ${targetId}`);
    if (!isAntigravityTarget(exact)) {
      throw new Error(
        `CDP target ${targetId} is not an Antigravity workbench. Refusing to route the request to a non-workbench target.`,
      );
    }
    return exact;
  }

  if (antigravityTargets.length === 1) return antigravityTargets[0];

  if (antigravityTargets.length > 1) {
    const candidates = antigravityTargets.map(describeTarget).join('; ');
    throw new Error(
      `Multiple Antigravity workbench targets are open (${antigravityTargets.length}). ` +
      `Refusing implicit project selection. Call list_antigravity_targets and retry with the intended targetId. ` +
      `Candidates: ${candidates}`,
    );
  }

  throw new Error('No Antigravity CDP target found. Launch Antigravity with remote debugging enabled.');
}

function workspaceProjectName(workspacePath: string): string {
  return path.basename(path.resolve(workspacePath));
}

function targetProjectName(target: CdpTarget): string {
  const title = (target.title ?? '').trim();
  const firstSegment = title.split(/\s[—–-]\s/)[0]?.trim();
  return firstSegment || '';
}

export function targetMatchesWorkspaceName(target: CdpTarget, workspacePath: string): boolean {
  return targetProjectName(target).toLowerCase() === workspaceProjectName(workspacePath).toLowerCase();
}

export function selectWorkspaceTarget(
  targets: CdpTarget[],
  workspacePath: string,
  targetId?: string,
): CdpTarget | null {
  const normalizedPath = path.resolve(workspacePath);
  const projectName = workspaceProjectName(normalizedPath);

  if (targetId) {
    const exact = selectAntigravityTarget(targets, targetId);
    if (!targetMatchesWorkspaceName(exact, normalizedPath)) {
      throw new Error(
        `CDP target ${targetId} belongs to ${JSON.stringify(targetProjectName(exact) || '(unknown)')}, ` +
        `not requested workspace ${JSON.stringify(projectName)}. Refusing cross-project execution.`,
      );
    }
    return exact;
  }

  const matches = targets.filter(
    (target) => isAntigravityTarget(target) && targetMatchesWorkspaceName(target, normalizedPath),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Multiple Antigravity targets match workspace name ${JSON.stringify(projectName)}. ` +
      `Refusing to guess between same-name projects. Pass the exact targetId.`,
    );
  }
  return null;
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function launchAntigravityWorkspace(workspacePath: string): Promise<void> {
  if (process.platform === 'darwin') {
    const appNames = ['Antigravity IDE', 'Antigravity'];
    let lastError: unknown;
    for (const appName of appNames) {
      try {
        await runProcess('open', ['-na', appName, '--args', '--new-window', workspacePath]);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Failed to launch Antigravity for ${workspacePath}: ${String(lastError)}`);
  }

  const command = process.env.ANTIGRAVITY_PATH?.trim() || 'antigravity';
  await runProcess(command, ['--new-window', workspacePath]);
}

async function ensureWorkspaceDirectory(workspacePath: string): Promise<string> {
  const normalizedPath = path.resolve(workspacePath);
  const info = await stat(normalizedPath).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`Workspace path does not exist or is not a directory: ${normalizedPath}`);
  }
  return normalizedPath;
}

export async function resolveAntigravityTarget(targetId?: string, workspacePath?: string): Promise<CdpTarget> {
  if (!workspacePath?.trim()) {
    return selectAntigravityTarget(await discoverTargets(), targetId);
  }

  const normalizedPath = await ensureWorkspaceDirectory(workspacePath);
  const initialTargets = await discoverTargets();
  const existing = selectWorkspaceTarget(initialTargets, normalizedPath, targetId);
  if (existing) return existing;
  if (targetId) {
    throw new Error(`Requested targetId ${targetId} was not found for workspace ${normalizedPath}.`);
  }

  const beforeIds = new Set(initialTargets.filter(isAntigravityTarget).map((target) => target.id));
  await launchAntigravityWorkspace(normalizedPath);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const targets = await discoverTargets();
    const nameMatches = targets.filter(
      (target) => isAntigravityTarget(target) && targetMatchesWorkspaceName(target, normalizedPath),
    );
    const newlyOpened = nameMatches.filter((target) => !beforeIds.has(target.id));

    if (newlyOpened.length === 1) return newlyOpened[0];
    if (newlyOpened.length > 1) {
      throw new Error(
        `Launching ${normalizedPath} created multiple matching Antigravity targets. ` +
        `Refusing ambiguous project selection; use list_antigravity_targets and pass targetId.`,
      );
    }

    // Some Antigravity builds reuse the existing CDP port/instance and update the
    // workbench title only after launch. Accept a single exact project-name match.
    if (nameMatches.length === 1) return nameMatches[0];
  }

  throw new Error(
    `Antigravity was launched for ${normalizedPath}, but no matching CDP target appeared within 30 seconds. ` +
    `Refusing to fall back to another open project.`,
  );
}

export class CdpConnection {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly contexts = new Set<number>();

  constructor(private readonly target: CdpTarget) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const url = this.target.webSocketDebuggerUrl;
    if (!url) throw new Error('Target has no webSocketDebuggerUrl');

    const socket = new WebSocket(url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Failed to connect to Antigravity CDP WebSocket'));
      };
      const cleanup = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
    });

    socket.addEventListener('message', (event) => this.handleMessage(String(event.data)));
    socket.addEventListener('close', () => this.rejectAll(new Error('CDP WebSocket disconnected')));
    await this.call('Runtime.enable');
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.rejectAll(new Error('CDP connection closed'));
  }

  getContextIds(): number[] {
    return [...this.contexts];
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<any> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('CDP connection is not open');

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP call timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(payload);
    });
  }

  async evaluate(expression: string, contextId?: number): Promise<any> {
    const params: Record<string, unknown> = {
      expression,
      returnByValue: true,
      awaitPromise: true,
    };
    if (contextId !== undefined) params.contextId = contextId;
    const result = await this.call('Runtime.evaluate', params);
    if (result?.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(description || 'Runtime.evaluate failed');
    }
    return result?.result?.value;
  }

  private handleMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    }

    if (message.method === 'Runtime.executionContextCreated') {
      const id = message.params?.context?.id;
      if (typeof id === 'number') this.contexts.add(id);
    } else if (message.method === 'Runtime.executionContextDestroyed') {
      const id = message.params?.executionContextId;
      if (typeof id === 'number') this.contexts.delete(id);
    } else if (message.method === 'Runtime.executionContextsCleared') {
      this.contexts.clear();
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
