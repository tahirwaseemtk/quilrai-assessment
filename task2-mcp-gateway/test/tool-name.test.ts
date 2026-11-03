import { describe, expect, it } from 'vitest';
import { isValidToolName } from '../src/tool-name.js';

const cp = (...points: number[]) => String.fromCodePoint(...points);
const unit = (code: number) => String.fromCharCode(code);

describe('isValidToolName', () => {
  it.each([
    'a',
    'A',
    '0',
    '_',
    '.',
    '-',
    'a.b-c_D9',
    'a'.repeat(128),
    'admin',
    'constructor',
    '__proto__',
    'toString',
  ])('accepts %s', (name) => {
    expect(isValidToolName(name)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['129 characters', 'a'.repeat(129)],
    ['a space inside', 'a b'],
    ['a leading space', ' a'],
    ['a trailing space', 'a '],
    ['a trailing newline', 'a\n'],
    ['a leading newline', '\na'],
    ['a tab', 'a\tb'],
    ['NUL', 'a' + unit(0) + 'b'],
    ['a slash', 'a/b'],
    ['a colon', 'a:b'],
    ['a semicolon', 'a;b'],
    ['a star', 'a*'],
    ['percent encoding', 'a%2Fb'],
    ['percent-encoded letter', 'a%41'],
    ['a fullwidth letter', cp(0xff41) + 'dmin'],
    ['a Cyrillic letter', cp(0x430) + 'dmin'],
    ['a trailing zero-width space', 'admin' + cp(0x200b)],
    ['a leading zero-width space', cp(0x200b) + 'admin'],
    ['a lone high surrogate', 'a' + unit(0xd800)],
    ['a lone low surrogate', 'a' + unit(0xdc00)],
    ['an accented letter', cp(0xe9)],
    ['the long s', cp(0x17f) + 'dmin'],
    ['the Kelvin sign', cp(0x212a)],
  ])('rejects %s', (_label, name) => {
    expect(isValidToolName(name)).toBe(false);
  });

  it('rejects a huge name quickly', () => {
    const started = performance.now();
    expect(isValidToolName('a'.repeat(1_000_000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
