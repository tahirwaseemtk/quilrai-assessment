import { describe, expect, it } from 'vitest';
import { hasDuplicateKeys } from '../json-duplicate-keys.js';

const BS = String.fromCharCode(92);

describe('hasDuplicateKeys', () => {
  it.each([
    '{"a":1,"a":2}',
    '{"a":1, "a" :2}',
    '{"x":{"b":1,"b":2}}',
    '[{"k":1},{"k":1,"k":2}]',
    `{"name":1,"na${BS}u006de":2}`,
    `{"a${BS}"b":1,"a${BS}"b":2}`,
  ])('finds the duplicate in %s', (text) => {
    expect(hasDuplicateKeys(text)).toBe(true);
  });

  it.each([
    '{}',
    '[]',
    '{"a":1,"b":2}',
    '{"a":{"a":{"a":1}}}',
    '[{"k":1},{"k":2}]',
    '{"a":"a","b":"a"}',
    `{"a":"x${BS}":y","b":":"}`,
    '["a","a"]',
    '{"a":["b","b"],"b":1}',
  ])('accepts %s', (text) => {
    expect(hasDuplicateKeys(text)).toBe(false);
  });

  it('scans a deeply nested document without recursion', () => {
    const depth = 100_000;
    const text = `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
    expect(hasDuplicateKeys(text)).toBe(false);
  });

  it('scans a large document in linear time', () => {
    const text = `{${Array.from({ length: 200_000 }, (_, i) => `"k${i}":${i}`).join(',')}}`;
    const start = performance.now();
    expect(hasDuplicateKeys(text)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('hasDuplicateKeys: folding and robustness', () => {
  const char = (codePoint: number): string => String.fromCodePoint(codePoint);

  it.each([
    '{"name":1,"NAME":2}',
    '{"Name":1,"name":2}',
    `{"s":1,"${char(0x17f)}":2}`,
    `{"k":1,"${char(0x212a)}":2}`,
    `{"name":1,"${char(0xff4e)}ame":2}`,
  ])('treats keys that fold to the same string as duplicates: %s', (text) => {
    expect(hasDuplicateKeys(text)).toBe(true);
  });

  it('keeps distinct keys distinct', () => {
    expect(hasDuplicateKeys('{"name":1,"names":2,"nam":3}')).toBe(false);
  });

  it.each(['{"a', '{"a":"b', '"'])(
    'reports the unterminated input %j as unsafe without hanging',
    (text) => {
      expect(hasDuplicateKeys(text)).toBe(true);
    },
  );

  it('reports an unparseable key as unsafe', () => {
    expect(hasDuplicateKeys(`{"a${BS}x":1}`)).toBe(true);
  });
});
