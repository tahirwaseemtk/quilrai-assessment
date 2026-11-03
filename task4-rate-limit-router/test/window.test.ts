import { describe, expect, it } from 'vitest';
import { retryAfterMs, windowStart } from '../src/window.js';

describe('window math', () => {
  it('starts the window one window back', () => {
    expect(windowStart(1000, 600)).toBe(400);
  });

  it('gives zero wait when the cost fits now', () => {
    expect(retryAfterMs([{ ts: 500, tokens: 40 }], 1000, 600, 100, 60)).toBe(0);
  });

  it('waits until the oldest row leaves when that is enough', () => {
    const rows = [
      { ts: 500, tokens: 60 },
      { ts: 700, tokens: 40 },
    ];
    // used 100 of 100; the row at ts 500 leaves at 500 + 600 = 1100, freeing 60.
    expect(retryAfterMs(rows, 1000, 600, 100, 50)).toBe(100);
  });

  it('waits for several rows when one is not enough', () => {
    const rows = [
      { ts: 500, tokens: 30 },
      { ts: 600, tokens: 30 },
      { ts: 900, tokens: 40 },
    ];
    // used 100; after the first row leaves 70 is used, still too many for 50 more.
    expect(retryAfterMs(rows, 1000, 600, 100, 50)).toBe(200);
  });

  it('returns the full window when even an empty window cannot fit the cost', () => {
    expect(retryAfterMs([], 1000, 600, 100, 101)).toBe(600);
  });
});
