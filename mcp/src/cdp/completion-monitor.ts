import { CdpConnection } from './client';

export interface CompletionMonitorOptions {
  baselineText?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  stablePollCount?: number;
}

export interface CompletionMonitorResult {
  completed: boolean;
  timedOut: boolean;
  generationStarted: boolean;
  elapsedMs: number;
  text: string;
  polls: number;
}

const RESPONSE_TEXT_SCRIPT = `(() => {
  const panel = document.querySelector('.antigravity-agent-side-panel') || document;
  const turns = panel.querySelectorAll('[data-message-author-role="assistant"], [data-message-role="assistant"]');
  const scope = turns.length ? turns[turns.length - 1] : panel;
  const selectors = [
    '.rendered-markdown',
    '.leading-relaxed.select-text',
    '.flex.flex-col.gap-y-3',
    '[class*="assistant-message"]',
    '[class*="message-content"]',
    '[class*="markdown-body"]',
    '.prose'
  ];
  for (const selector of selectors) {
    const nodes = Array.from(scope.querySelectorAll(selector));
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (!(node instanceof HTMLElement)) continue;
      if (node.closest('details, footer, [class*="feedback"], [role="dialog"]')) continue;
      const text = (node.innerText || node.textContent || '').replace(/\\r/g, '').trim();
      if (text.length >= 2) return text;
    }
  }
  return (scope.innerText || scope.textContent || '').replace(/\\r/g, '').trim();
})()`;

const GENERATION_STATE_SCRIPT = `(() => {
  const panel = document.querySelector('.antigravity-agent-side-panel');
  const scopes = [panel, document].filter(Boolean);
  for (const scope of scopes) {
    const primary = scope.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    if (primary instanceof HTMLElement && primary.offsetParent !== null) return true;
  }
  const normalize = (value) => (value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
  const patterns = [/^stop$/, /^stop generating$/, /^stop response$/, /^停止$/, /^生成を停止$/, /^応答を停止$/];
  for (const scope of scopes) {
    const buttons = scope.querySelectorAll('button, [role="button"]');
    for (const button of buttons) {
      if (!(button instanceof HTMLElement) || button.offsetParent === null) continue;
      const labels = [button.textContent || '', button.getAttribute('aria-label') || '', button.getAttribute('title') || ''];
      if (labels.some((label) => patterns.some((re) => re.test(normalize(label))))) return true;
    }
  }
  return false;
})()`;

function contextCandidates(cdp: CdpConnection): Array<number | undefined> {
  return [undefined, ...cdp.getContextIds()];
}

export async function readLatestResponseText(cdp: CdpConnection): Promise<string> {
  let best = '';
  for (const contextId of contextCandidates(cdp)) {
    try {
      const value = await cdp.evaluate(RESPONSE_TEXT_SCRIPT, contextId);
      if (typeof value === 'string' && value.trim().length > best.length) best = value.trim();
    } catch {
      // Ignore unrelated or destroyed execution contexts.
    }
  }
  return best;
}

export async function isGenerationRunning(cdp: CdpConnection): Promise<boolean> {
  for (const contextId of contextCandidates(cdp)) {
    try {
      if ((await cdp.evaluate(GENERATION_STATE_SCRIPT, contextId)) === true) return true;
    } catch {
      // Ignore unrelated or destroyed execution contexts.
    }
  }
  return false;
}

export async function waitForAntigravityCompletion(
  cdp: CdpConnection,
  options: CompletionMonitorOptions = {},
): Promise<CompletionMonitorResult> {
  const baselineText = (options.baselineText ?? '').trim();
  const timeoutMs = Math.max(10_000, options.timeoutMs ?? 600_000);
  const pollIntervalMs = Math.max(500, options.pollIntervalMs ?? 1_500);
  const stablePollCount = Math.max(2, options.stablePollCount ?? 3);
  const startedAt = Date.now();

  let generationStarted = false;
  let stableIdlePolls = 0;
  let lastText = '';
  let polls = 0;

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    polls++;

    const [running, currentText] = await Promise.all([
      isGenerationRunning(cdp),
      readLatestResponseText(cdp),
    ]);

    const normalizedText = currentText.trim();
    const changedFromBaseline = normalizedText.length > 0 && normalizedText !== baselineText;
    const textChanged = normalizedText.length > 0 && normalizedText !== lastText;

    if (running) {
      generationStarted = true;
      stableIdlePolls = 0;
    }

    if (changedFromBaseline) {
      generationStarted = true;
    }

    if (textChanged) {
      lastText = normalizedText;
      stableIdlePolls = 0;
    }

    if (!running && generationStarted) {
      stableIdlePolls++;
      if (stableIdlePolls >= stablePollCount) {
        return {
          completed: true,
          timedOut: false,
          generationStarted,
          elapsedMs: Date.now() - startedAt,
          text: lastText,
          polls,
        };
      }
    }
  }

  return {
    completed: false,
    timedOut: true,
    generationStarted,
    elapsedMs: Date.now() - startedAt,
    text: lastText,
    polls,
  };
}
