import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { repoRoot, serverEntry } from './helpers/process.js';

const taskDir = path.join(repoRoot, 'task1-mcp-server');
// Task 1 imports the shared logger, so its stdout guarantees depend on shared/ as well.
const sharedDir = path.join(repoRoot, 'shared');

function sourceFiles(dir: string, { includeTests = false } = {}): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'test' && !includeTests ? [] : sourceFiles(full, { includeTests });
    }
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('source encoding', () => {
  // Invisible, separator and replacement characters typed literally are unreviewable and silently lost by some editors;
  // write them as escapes or String.fromCodePoint instead.
  it('contains no literal invisible characters', () => {
    const files = [taskDir, sharedDir].flatMap((dir) => sourceFiles(dir, { includeTests: true }));
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(
        /[\p{Default_Ignorable_Code_Point}\u2028\u2029\uFFFD]/u,
      );
    }
  });
});

// The lint probes use a .js path: type-aware linting cannot resolve a .ts file that is not on
// disk. no-console is configured globally, so the result applies to the .ts sources as well.
describe('stdout hygiene', () => {
  it.each(['console.log(1);', 'console.info(1);', 'console.warn(1);'])(
    'lint rejects %s',
    async (code) => {
      const [result] = await new ESLint({ cwd: repoRoot }).lintText(code, {
        filePath: path.join(taskDir, 'src', 'probe.js'),
      });
      expect(result?.messages.map((message) => message.ruleId)).toEqual(['no-console']);
    },
  );

  it('lint allows console.error', async () => {
    const [result] = await new ESLint({ cwd: repoRoot }).lintText('console.error(1);', {
      filePath: path.join(taskDir, 'src', 'probe.js'),
    });
    expect(result?.messages).toEqual([]);
  });

  it('source never writes to stdout directly', () => {
    const files = [taskDir, sharedDir].flatMap((dir) => sourceFiles(dir));
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain(path.join(sharedDir, 'logger.ts'));
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/process\.stdout\.write|console\.(log|info|warn|debug)\(/);
    }
  });

  it('npm run task1 starts the same entry the tests spawn', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.task1).toBe(`tsx --env-file-if-exists=.env ${serverEntry}`);
  });
});
