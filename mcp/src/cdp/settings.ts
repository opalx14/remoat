import { CdpConnection, resolveAntigravityTarget } from './client';
import { antigravityTaskQueue } from '../orchestration/task-queue';
import type { CdpTarget } from '../types';

export const FALLBACK_MODELS = [
  'Gemini 3.8 Flash High',
  'Gemini 3.7 Flash Medium',
  'Gemini 3.6 Flash Medium',
  'Gemini 3.1 Pro Low',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS 120B (Medium)',
] as const;

export const AVAILABLE_MODES = ['fast', 'plan'] as const;

function contextCandidates(cdp: CdpConnection): Array<number | undefined> {
  return [undefined, ...cdp.getContextIds()];
}

async function evaluateFirst<T>(cdp: CdpConnection, expression: string): Promise<T | undefined> {
  for (const contextId of contextCandidates(cdp)) {
    try {
      const value = await cdp.evaluate(expression, contextId);
      if (value !== undefined && value !== null) return value as T;
    } catch {
      // Ignore unrelated/destroyed execution contexts.
    }
  }
  return undefined;
}

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

function normalizeModelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const LIST_MODELS_SCRIPT = `(async () => {
  try {
    const panel = document.querySelector('.antigravity-agent-side-panel') || document;
    const trigger = panel.querySelector('button[aria-label^="Select model, current:"]');
    if (trigger instanceof HTMLElement) {
      trigger.click();
      await new Promise(r => setTimeout(r, 250));
    }

    const menu = Array.from(document.querySelectorAll('[role="menu"]')).find(el => el instanceof HTMLElement && el.offsetParent !== null);
    const items = menu ? Array.from(menu.querySelectorAll('[role="menuitem"]')) : [];
    const models = items.map(item => {
      const effort = item.querySelector('[data-testid="model-selector-effort-group"]');
      if (effort) return (effort.textContent || '').replace(/\\s+/g, ' ').trim();
      const text = (item.textContent || '').replace(/\\s+/g, ' ').trim();
      return text.replace(/Fast$/, '').trim();
    }).filter(Boolean);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return models;
  } catch {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return [];
  }
})()`;

const CURRENT_MODEL_SCRIPT = `(() => {
  try {
    const panel = document.querySelector('.antigravity-agent-side-panel') || document;
    const trigger = panel.querySelector('button[aria-label^="Select model, current:"]');
    if (trigger) {
      const aria = trigger.getAttribute('aria-label') || '';
      const prefix = 'Select model, current:';
      if (aria.startsWith(prefix)) return aria.slice(prefix.length).trim();
      const text = (trigger.textContent || '').replace(/\\s+/g, ' ').trim();
      if (text) return text;
    }
    return null;
  } catch {
    return null;
  }
})()`;

export async function listModelsWithConnection(cdp: CdpConnection): Promise<string[]> {
  const models = await evaluateFirst<string[]>(cdp, LIST_MODELS_SCRIPT);
  const cleaned = Array.isArray(models)
    ? [...new Set(models.map((item) => String(item).trim()).filter(Boolean))]
    : [];
  return cleaned.length > 0 ? cleaned : [...FALLBACK_MODELS];
}

export async function getCurrentModelWithConnection(cdp: CdpConnection): Promise<string | null> {
  const current = await evaluateFirst<string | null>(cdp, CURRENT_MODEL_SCRIPT);
  return typeof current === 'string' && current.trim() ? current.trim() : null;
}

export async function setModelWithConnection(cdp: CdpConnection, modelName: string): Promise<Record<string, unknown>> {
  const requested = modelName.trim();
  if (!requested) throw new Error('model must be a non-empty string.');

  const expression = `(async () => {
    try {
      const panel = document.querySelector('.antigravity-agent-side-panel') || document;
      const normalize = (v) => (v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const requested = ${JSON.stringify(requested)};
      const requestedNorm = normalize(requested);
      const trigger = panel.querySelector('button[aria-label^="Select model, current:"]');
      if (!(trigger instanceof HTMLElement)) return { ok: false, error: 'Model selector button not found' };

      const currentAria = trigger.getAttribute('aria-label') || '';
      const current = currentAria.replace(/^Select model, current:\\s*/, '').trim();
      if (normalize(current) === requestedNorm) {
        return { ok: true, model: current, alreadySelected: true, verified: true };
      }

      trigger.click();
      await new Promise(r => setTimeout(r, 250));
      const menu = Array.from(document.querySelectorAll('[role="menu"]')).find(el => el instanceof HTMLElement && el.offsetParent !== null);
      if (!menu) return { ok: false, error: 'Model menu did not open' };
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
      const describe = (item) => {
        const effort = item.querySelector('[data-testid="model-selector-effort-group"]');
        if (effort) return (effort.textContent || '').replace(/\\s+/g, ' ').trim();
        return (item.textContent || '').replace(/\\s+/g, ' ').trim().replace(/Fast$/, '').trim();
      };
      const descriptors = items.map(item => {
        const effort = item.querySelector('[data-testid="model-selector-effort-group"]');
        return {
          item,
          label: describe(item),
          base: effort ? (effort.getAttribute('data-model-base') || '').trim() : '',
          hasSubmenu: item.getAttribute('aria-haspopup') === 'menu',
        };
      });

      let target = descriptors.find(entry => normalize(entry.label) === requestedNorm);
      if (!target) {
        target = descriptors.find(entry => entry.base && requestedNorm.startsWith(normalize(entry.base)));
      }
      if (!target || !(target.item instanceof HTMLElement)) {
        const available = descriptors.map(entry => entry.label).filter(Boolean);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { ok: false, error: 'Target model not found', available };
      }

      const baseNorm = normalize(target.base);
      const effortNorm = baseNorm && requestedNorm.startsWith(baseNorm)
        ? requestedNorm.slice(baseNorm.length)
        : '';

      if (target.hasSubmenu && effortNorm) {
        target.item.focus();
        target.item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
        await new Promise(r => setTimeout(r, 250));
        const visibleMenus = Array.from(document.querySelectorAll('[role="menu"]'))
          .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
        const submenu = visibleMenus[visibleMenus.length - 1];
        const efforts = submenu
          ? Array.from(submenu.querySelectorAll('[role="menuitemradio"]'))
          : [];
        const effortItem = efforts.find(item => normalize((item.textContent || '').trim()) === effortNorm);
        if (!(effortItem instanceof HTMLElement)) {
          const availableEfforts = efforts.map(item => (item.textContent || '').trim()).filter(Boolean);
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return { ok: false, error: 'Requested model effort not found', base: target.base, availableEfforts };
        }
        effortItem.click();
      } else {
        target.item.click();
      }

      await new Promise(r => setTimeout(r, 400));
      const updatedTrigger = panel.querySelector('button[aria-label^="Select model, current:"]');
      const updatedAria = updatedTrigger ? updatedTrigger.getAttribute('aria-label') || '' : '';
      const verifiedModel = updatedAria.replace(/^Select model, current:\\s*/, '').trim();
      const verified = normalize(verifiedModel) === requestedNorm;
      return { ok: verified, model: verifiedModel || target.label, alreadySelected: false, verified, error: verified ? undefined : 'Model selection could not be verified' };
    } catch (e) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { ok: false, error: String(e) };
    }
  })()`;

  const result = await evaluateFirst<Record<string, unknown>>(cdp, expression);
  if (!result?.ok) {
    throw new Error(typeof result?.error === 'string' ? result.error : `Failed to set model: ${requested}`);
  }
  return result;
}

const CURRENT_MODE_SCRIPT = `(() => {
  const uiNameMap = { fast: 'Fast', plan: 'Planning' };
  const knownModes = Object.values(uiNameMap).map(n => n.toLowerCase());
  const reverseMap = {};
  Object.entries(uiNameMap).forEach(([k, v]) => { reverseMap[v.toLowerCase()] = k; });
  const buttons = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
  const modeToggle = buttons.find(b => {
    const text = (b.textContent || '').trim().toLowerCase();
    const hasChevron = b.querySelector('svg[class*="chevron"]');
    return knownModes.includes(text) && !!hasChevron;
  });
  if (!modeToggle) return null;
  return reverseMap[(modeToggle.textContent || '').trim().toLowerCase()] || null;
})()`;

export async function getCurrentModeWithConnection(cdp: CdpConnection): Promise<string | null> {
  const mode = await evaluateFirst<string | null>(cdp, CURRENT_MODE_SCRIPT);
  return typeof mode === 'string' && mode.trim() ? mode.trim() : null;
}

export async function setModeWithConnection(cdp: CdpConnection, modeName: string): Promise<Record<string, unknown>> {
  const normalized = modeName.trim().toLowerCase() === 'planning' ? 'plan' : modeName.trim().toLowerCase();
  if (!AVAILABLE_MODES.includes(normalized as (typeof AVAILABLE_MODES)[number])) {
    throw new Error(`Invalid mode "${modeName}". Available modes: ${AVAILABLE_MODES.join(', ')}`);
  }

  const expression = `(async () => {
    const targetMode = ${JSON.stringify(normalized)};
    const uiNameMap = { fast: 'Fast', plan: 'Planning' };
    const targetUi = uiNameMap[targetMode];
    const knownModes = Object.values(uiNameMap).map(v => v.toLowerCase());
    const buttons = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
    const toggle = buttons.find(b => {
      const text = (b.textContent || '').trim().toLowerCase();
      return knownModes.includes(text) && !!b.querySelector('svg[class*="chevron"]');
    });
    if (!toggle) return { ok: false, error: 'Mode toggle button not found' };
    const current = (toggle.textContent || '').trim();
    if (current.toLowerCase() === targetUi.toLowerCase()) {
      return { ok: true, mode: targetMode, displayName: current, alreadySelected: true };
    }
    toggle.click();
    await new Promise(r => setTimeout(r, 400));
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(d => {
      const style = getComputedStyle(d);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    const scope = dialogs[dialogs.length - 1] || document;
    const candidates = Array.from(scope.querySelectorAll('button, div.cursor-pointer, .font-medium'));
    let option = candidates.find(el => (el.textContent || '').trim().toLowerCase() === targetUi.toLowerCase());
    if (option && !(option instanceof HTMLButtonElement) && !(option.classList && option.classList.contains('cursor-pointer'))) {
      option = option.closest('button, div.cursor-pointer') || option;
    }
    if (!(option instanceof HTMLElement)) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { ok: false, error: 'Mode option not found: ' + targetUi };
    }
    option.click();
    await new Promise(r => setTimeout(r, 400));
    return { ok: true, mode: targetMode, displayName: targetUi };
  })()`;

  const result = await evaluateFirst<Record<string, unknown>>(cdp, expression);
  if (!result?.ok) {
    throw new Error(typeof result?.error === 'string' ? result.error : `Failed to set mode: ${modeName}`);
  }
  return result;
}

export async function listModels(targetId?: string, workspacePath?: string): Promise<Record<string, unknown>> {
  return withTarget(targetId, workspacePath, async (cdp, target) => ({
    targetId: target.id,
    targetTitle: target.title ?? '',
    models: await listModelsWithConnection(cdp),
  }));
}

export async function getCurrentModel(targetId?: string, workspacePath?: string): Promise<Record<string, unknown>> {
  return withTarget(targetId, workspacePath, async (cdp, target) => ({
    targetId: target.id,
    targetTitle: target.title ?? '',
    model: await getCurrentModelWithConnection(cdp),
  }));
}

export async function setCurrentModel(model: string, targetId?: string, workspacePath?: string): Promise<Record<string, unknown>> {
  const target = await resolveAntigravityTarget(targetId, workspacePath);
  const queued = await antigravityTaskQueue.submit(`target:${target.id}`, async () =>
    withTarget(target.id, workspacePath, async (cdp, exactTarget) => ({
      targetId: exactTarget.id,
      targetTitle: exactTarget.title ?? '',
      ...(await setModelWithConnection(cdp, model)),
    })),
  );
  return { ...queued.value, queue: queued.queue };
}

export async function getCurrentMode(targetId?: string, workspacePath?: string): Promise<Record<string, unknown>> {
  return withTarget(targetId, workspacePath, async (cdp, target) => {
    const mode = await getCurrentModeWithConnection(cdp);
    return {
      targetId: target.id,
      targetTitle: target.title ?? '',
      mode,
      supported: mode !== null,
      availableModes: [...AVAILABLE_MODES],
      note: mode === null ? 'This Antigravity UI does not currently expose the legacy Fast/Planning mode toggle.' : undefined,
    };
  });
}

export async function setCurrentMode(mode: string, targetId?: string, workspacePath?: string): Promise<Record<string, unknown>> {
  const target = await resolveAntigravityTarget(targetId, workspacePath);
  const queued = await antigravityTaskQueue.submit(`target:${target.id}`, async () =>
    withTarget(target.id, workspacePath, async (cdp, exactTarget) => ({
      targetId: exactTarget.id,
      targetTitle: exactTarget.title ?? '',
      ...(await setModeWithConnection(cdp, mode)),
    })),
  );
  return { ...queued.value, queue: queued.queue };
}

export function modelsMatch(left: string, right: string): boolean {
  return normalizeModelName(left) === normalizeModelName(right);
}
