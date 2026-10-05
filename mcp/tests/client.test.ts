import { describe, expect, test } from 'bun:test';
import {
  isAntigravityTarget,
  selectAntigravityTarget,
  selectWorkspaceTarget,
  targetMatchesWorkspaceName,
} from '../src/cdp/client';
import type { CdpTarget } from '../src/types';

function target(overrides: Partial<CdpTarget> = {}): CdpTarget {
  return {
    id: 'target-1',
    type: 'page',
    title: 'Project — Antigravity',
    url: 'vscode-file://vscode-app/workbench/workbench.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/target-1',
    port: 9333,
    ...overrides,
  };
}

describe('isAntigravityTarget', () => {
  test('accepts an Antigravity workbench page', () => {
    expect(isAntigravityTarget(target())).toBe(true);
  });

  test('accepts Antigravity IDE v2 title through substring matching', () => {
    expect(isAntigravityTarget(target({ title: 'Project — Antigravity IDE' }))).toBe(true);
  });

  test('rejects Launchpad targets', () => {
    expect(isAntigravityTarget(target({ title: 'Launchpad — Antigravity' }))).toBe(false);
  });

  test('rejects internal agent webviews', () => {
    expect(isAntigravityTarget(target({ url: 'https://example.test/workbench-jetski-agent' }))).toBe(false);
  });

  test('requires a debugger websocket', () => {
    expect(isAntigravityTarget(target({ webSocketDebuggerUrl: undefined }))).toBe(false);
  });
});

describe('selectAntigravityTarget', () => {
  test('auto-selects the only Antigravity workbench', () => {
    const only = target({ id: 'only-target', title: 'alpha — Antigravity' });
    expect(selectAntigravityTarget([only])).toBe(only);
  });

  test('refuses implicit selection when multiple Antigravity workbenches are open', () => {
    const alpha = target({ id: 'alpha-target', title: 'alpha — Antigravity' });
    const beta = target({ id: 'beta-target', title: 'beta — Antigravity', port: 9444 });

    expect(() => selectAntigravityTarget([alpha, beta])).toThrow(
      /Multiple Antigravity workbench targets are open.*retry with the intended targetId/i,
    );
  });

  test('selects the exact requested target when multiple workbenches are open', () => {
    const alpha = target({ id: 'alpha-target', title: 'alpha — Antigravity' });
    const beta = target({ id: 'beta-target', title: 'beta — Antigravity', port: 9444 });

    expect(selectAntigravityTarget([alpha, beta], 'beta-target')).toBe(beta);
  });

  test('refuses an explicit target that is not an Antigravity workbench', () => {
    const workbench = target({ id: 'alpha-target', title: 'alpha — Antigravity' });
    const devtools = target({
      id: 'devtools-target',
      title: 'DevTools',
      url: 'devtools://devtools/bundled/inspector.html',
    });

    expect(() => selectAntigravityTarget([workbench, devtools], 'devtools-target')).toThrow(
      /not an Antigravity workbench/i,
    );
  });
});

describe('workspace routing', () => {
  test('matches a target by the exact workspace basename segment', () => {
    const remoat = target({ id: 'remoat-target', title: 'remoat — skill.md' });
    expect(targetMatchesWorkspaceName(remoat, '/Users/example/GitHub/remoat')).toBe(true);
    expect(targetMatchesWorkspaceName(remoat, '/Users/example/GitHub/remoat-old')).toBe(false);
  });

  test('selects the project matching workspacePath even when another project is open', () => {
    const like14 = target({ id: 'like14-target', title: 'like14 — page.tsx' });
    const remoat = target({ id: 'remoat-target', title: 'remoat — skill.md' });

    expect(selectWorkspaceTarget([like14, remoat], '/Users/example/GitHub/remoat')).toBe(remoat);
  });

  test('returns null instead of falling back to a different open project', () => {
    const like14 = target({ id: 'like14-target', title: 'like14 — page.tsx' });
    expect(selectWorkspaceTarget([like14], '/Users/example/GitHub/remoat')).toBeNull();
  });

  test('rejects targetId when it belongs to a different project', () => {
    const like14 = target({ id: 'like14-target', title: 'like14 — page.tsx' });
    expect(() => selectWorkspaceTarget([like14], '/Users/example/GitHub/remoat', 'like14-target')).toThrow(
      /Refusing cross-project execution/i,
    );
  });
});
