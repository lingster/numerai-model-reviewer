/**
 * Unit tests for the bounded-concurrency helper.
 */
import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from './concurrency';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('mapWithConcurrency', () => {
  it('returns an empty array for empty input', async () => {
    const out = await mapWithConcurrency([], 4, async () => 1);
    expect(out).toEqual([]);
  });

  it('preserves input order in results regardless of completion order', async () => {
    const items = [30, 10, 20, 0, 5];
    const out = await mapWithConcurrency(items, 3, async (ms, i) => {
      await new Promise(r => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:10', '2:20', '3:0', '4:5']);
  });

  it('passes the index to the worker', async () => {
    const out = await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, i) => `${i}-${item}`);
    expect(out).toEqual(['0-a', '1-b', '2-c']);
  });

  it('never runs more than `limit` workers at once', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      await tick();
      active--;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually ran concurrently
  });

  it('processes every item exactly once', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const seen: number[] = [];
    await mapWithConcurrency(items, 8, async (n) => {
      seen.push(n);
      return n;
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it('clamps a limit below 1 to sequential (still completes)', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6]);
  });

  it('propagates a worker rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      })
    ).rejects.toThrow('boom');
  });
});
