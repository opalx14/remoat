import { describe, expect, test } from 'bun:test';
import {
  MAX_PENDING_TASKS_PER_TARGET,
  QueueFullError,
  TargetTaskQueue,
} from '../src/orchestration/task-queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('TargetTaskQueue', () => {
  test('serializes tasks for the same target and preserves order', async () => {
    const queue = new TargetTaskQueue();
    const gate = deferred();
    const events: string[] = [];

    const first = queue.submit('target:a', async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
      return 'A';
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = queue.submit('target:a', async () => {
      events.push('second:start');
      events.push('second:end');
      return 'B';
    });

    expect(queue.snapshot('target:a').running).toBe(true);
    expect(queue.snapshot('target:a').pending).toBe(1);
    expect(events).toEqual(['first:start']);

    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(firstResult.value).toBe('A');
    expect(firstResult.queue.queued).toBe(false);
    expect(secondResult.value).toBe('B');
    expect(secondResult.queue.queued).toBe(true);
    expect(secondResult.queue.queuePosition).toBe(1);
    expect(queue.snapshot('target:a').running).toBe(false);
  });

  test('allows different targets to run concurrently', async () => {
    const queue = new TargetTaskQueue();
    const gate = deferred();
    const started = new Set<string>();

    const first = queue.submit('target:a', async () => {
      started.add('a');
      await gate.promise;
      return 'A';
    });
    const second = queue.submit('target:b', async () => {
      started.add('b');
      await gate.promise;
      return 'B';
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toEqual(new Set(['a', 'b']));
    gate.resolve();
    await Promise.all([first, second]);
  });

  test('caps pending tasks at Remoat core queue depth', async () => {
    const queue = new TargetTaskQueue();
    const gate = deferred();
    const running = queue.submit('target:a', async () => {
      await gate.promise;
      return 'running';
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const pending = Array.from({ length: MAX_PENDING_TASKS_PER_TARGET }, (_, index) =>
      queue.submit('target:a', async () => `pending-${index}`),
    );

    expect(() => queue.submit('target:a', async () => 'overflow')).toThrow(QueueFullError);
    gate.resolve();
    await Promise.all([running, ...pending]);
  });
});
