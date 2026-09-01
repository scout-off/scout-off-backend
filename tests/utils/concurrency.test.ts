/**
 * Tests for the concurrency limiter.
 * Verifies that the semaphore correctly limits simultaneous operations.
 */
import { Semaphore, withConcurrencyLimit } from '../../src/utils/concurrency';

describe('Semaphore', () => {
  it('limits concurrent execution to max permits', async () => {
    const semaphore = new Semaphore(3);
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const task = async () => {
      await semaphore.acquire();
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);

      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 10));

      currentConcurrent--;
      semaphore.release();
    };

    // Run 10 tasks with limit of 3
    const promises = Array.from({ length: 10 }, () => task());
    await Promise.all(promises);

    expect(maxConcurrent).toBe(3);
  });

  it('processes all tasks eventually despite concurrency limit', async () => {
    const semaphore = new Semaphore(2);
    const executed: number[] = [];

    const task = async (id: number) => {
      await semaphore.acquire();
      executed.push(id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      semaphore.release();
    };

    const promises = Array.from({ length: 5 }, (_, i) => task(i));
    await Promise.all(promises);

    expect(executed).toHaveLength(5);
    expect(executed.sort()).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('withConcurrencyLimit', () => {
  it('executes tasks with concurrency limit of 5', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const createTask = () => {
      return async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);

        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10));

        currentConcurrent--;
        return 'success';
      };
    };

    // Create 20 tasks
    const tasks = Array.from({ length: 20 }, createTask);

    const results = await withConcurrencyLimit(tasks, 5);

    // Verify concurrency limit was respected
    expect(maxConcurrent).toBeLessThanOrEqual(5);
    expect(maxConcurrent).toBeGreaterThan(0);

    // Verify all tasks completed
    expect(results).toHaveLength(20);
    expect(results.every((r) => r.status === 'fulfilled' && r.value === 'success')).toBe(true);
  });

  it('handles task failures with allSettled semantics', async () => {
    const createTask = (shouldFail: boolean) => {
      return async () => {
        if (shouldFail) {
          throw new Error('Task failed');
        }
        return 'success';
      };
    };

    // Create 5 tasks: 2 fail, 3 succeed
    const tasks = [
      createTask(false),
      createTask(true),
      createTask(false),
      createTask(true),
      createTask(false),
    ];

    const results = await withConcurrencyLimit(tasks, 5);

    // Verify all tasks were attempted
    expect(results).toHaveLength(5);

    // Verify correct outcomes
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'success' });
    expect(results[1]).toEqual({ status: 'rejected', reason: expect.any(Error) });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'success' });
    expect(results[3]).toEqual({ status: 'rejected', reason: expect.any(Error) });
    expect(results[4]).toEqual({ status: 'fulfilled', value: 'success' });
  });

  it('maintains task result order matching input order', async () => {
    const createTask = (id: number) => {
      return async () => {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
        return id;
      };
    };

    const tasks = Array.from({ length: 10 }, (_, i) => createTask(i));

    const results = await withConcurrencyLimit(tasks, 3);

    // Results should be in same order as input tasks
    expect(results.map((r) => r.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('works with limit of 1 (sequential execution)', async () => {
    const execution: number[] = [];

    const createTask = (id: number) => {
      return async () => {
        execution.push(id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return id;
      };
    };

    const tasks = Array.from({ length: 5 }, (_, i) => createTask(i));
    const results = await withConcurrencyLimit(tasks, 1);

    // With concurrency 1, tasks execute in order
    expect(execution).toEqual([0, 1, 2, 3, 4]);
    expect(results).toHaveLength(5);
  });

  it('works with limit greater than task count', async () => {
    const createTask = (id: number) => {
      return async () => id;
    };

    const tasks = Array.from({ length: 3 }, (_, i) => createTask(i));
    const results = await withConcurrencyLimit(tasks, 10);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });
});
