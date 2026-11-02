import { spawn, type SpawnOptions } from 'node:child_process';
import path from 'node:path';

export const repoRoot = path.resolve(import.meta.dirname, '../../..');
export const serverEntry = 'task1-mcp-server/index.ts';
export const serverCommand = process.execPath;
export const serverArgs = ['--env-file-if-exists=.env', '--import', 'tsx', serverEntry];

export interface SessionResult {
  stdoutLines: string[];
  stderrLines: string[];
  exitCode: number | null;
}

export interface Launch {
  command: string;
  args: string[];
  shell?: boolean;
}

export const directLaunch: Launch = { command: serverCommand, args: serverArgs };
// A shell resolves npm.cmd on Windows; the command string carries no external input.
export const npmSilentLaunch: Launch = {
  command: 'npm run --silent task1',
  args: [],
  shell: true,
};

export function rawSession(
  lines: string[],
  { launch = directLaunch, timeoutMs = 8000 }: { launch?: Launch; timeoutMs?: number } = {},
): Promise<SessionResult> {
  return new Promise((resolve, reject) => {
    const options: SpawnOptions = {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LOG_LEVEL: 'debug' },
      shell: launch.shell ?? false,
    };
    const child = spawn(launch.command, launch.args, options);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP server session timed out'));
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const split = (chunks: Buffer[]): string[] =>
        Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean);
      resolve({ stdoutLines: split(stdout), stderrLines: split(stderr), exitCode });
    });
    child.stdin?.end(lines.map((line) => `${line}\n`).join(''));
  });
}
