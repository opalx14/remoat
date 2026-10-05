import { randomUUID } from 'node:crypto';

export const MAX_PENDING_TASKS_PER_TARGET = 3;

export interface QueueSnapshot {
  key: string;
  running: boolean;
  runningTaskId?: string;
  pending: number;
  pendingTaskIds: string[];
  maxPending: number;
}

export interface QueueExecutionMeta {
  taskId: string;
  key: string;
  queued: boolean;
  queuePosition: number;
  queuedAt: number;
  startedAt: number;
  queueWaitMs: number;
}

export interface QueueExecutionResult<T> {
  value: T;
  queue: QueueExecutionMeta;
}

interface QueueEntry<T = unknown> {
  id: string;
  queuedAt: number;
  queuePosition: number;
  task: () => Promise<T>;
  resolve: (value: QueueExecutionResult<T>) => void;
  reject: (reason?: unknown) => void;
}

interface QueueState {
  running: boolean;
  runningTaskId?: string;
  pending: QueueEntry[];
}

export class QueueFullError extends Error {
  constructor(key: string) {
    super(`Task queue is full for ${key} (${MAX_PENDING_TASKS_PER_TARGET} pending tasks).`);
    this.name = 'QueueFullError';
  }
}

/**
 * In-memory per-target serial queue modeled after Remoat core's PromptDispatcher
 * + interruptState semantics. One task runs per target; up to three additional
 * tasks wait without being injected into Antigravity.
 */
export class TargetTaskQueue {
  private readonly states = new Map<string, QueueState>();

  submit<T>(key: string, task: () => Promise<T>): Promise<QueueExecutionResult<T>> {
    const normalizedKey = key.trim();
    if (!normalizedKey) throw new Error('Queue key must not be empty.');

    const state = this.states.get(normalizedKey) ?? { running: false, pending: [] };
    this.states.set(normalizedKey, state);

    const queued = state.running;
    if (queued && state.pending.length >= MAX_PENDING_TASKS_PER_TARGET) {
      throw new QueueFullError(normalizedKey);
    }

    const queuePosition = queued ? state.pending.length + 1 : 0;
    const entryId = randomUUID();

    return new Promise<QueueExecutionResult<T>>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        id: entryId,
        queuedAt: Date.now(),
        queuePosition,
        task,
        resolve,
        reject,
      };

      if (state.running) {
        state.pending.push(entry as QueueEntry);
        return;
      }

      state.running = true;
      void this.execute(normalizedKey, state, entry as QueueEntry);
    });
  }

  snapshot(key: string): QueueSnapshot {
    const state = this.states.get(key);
    return {
      key,
      running: state?.running ?? false,
      runningTaskId: state?.runningTaskId,
      pending: state?.pending.length ?? 0,
      pendingTaskIds: state?.pending.map((entry) => entry.id) ?? [],
      maxPending: MAX_PENDING_TASKS_PER_TARGET,
    };
  }

  snapshots(): QueueSnapshot[] {
    return [...this.states.keys()].map((key) => this.snapshot(key));
  }

  private async execute(key: string, state: QueueState, entry: QueueEntry): Promise<void> {
    const startedAt = Date.now();
    state.runningTaskId = entry.id;

    try {
      const value = await entry.task();
      entry.resolve({
        value,
        queue: {
          taskId: entry.id,
          key,
          queued: entry.queuePosition > 0,
          queuePosition: entry.queuePosition,
          queuedAt: entry.queuedAt,
          startedAt,
          queueWaitMs: startedAt - entry.queuedAt,
        },
      });
    } catch (reason) {
      entry.reject(reason);
    } finally {
      const next = state.pending.shift();
      if (next) {
        // Its original queuePosition records how far back it was when submitted.
        void this.execute(key, state, next);
      } else {
        state.running = false;
        state.runningTaskId = undefined;
        this.states.delete(key);
      }
    }
  }
}

export const antigravityTaskQueue = new TargetTaskQueue();
