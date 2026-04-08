import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

test('garrison without args launches workflow menu and exits cleanly', async () => {
  const cliPath = join(process.cwd(), 'dist', 'cli.js');

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    child.stdin.write('6\n');
    child.stdin.end();
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /No command provided\. Starting guided workflow\./);
  assert.match(result.stdout, /Garrison Workflow Launcher/);
  assert.match(result.stdout, /Select an option \[1-6\]:/);
  assert.match(result.stdout, /Exiting\./);
  assert.equal(result.stderr, '');
});