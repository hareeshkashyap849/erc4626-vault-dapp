/**
 * Run every test file, one child process at a time, in-process.
 *
 * WHY NOT `node --test test/*.test.ts`
 *
 * `node --test` spawns a child per file and captures its output over a named pipe. In the restricted
 * sandbox this workspace runs in, creating that pipe is refused and the whole run dies before a single
 * assertion executes -- all seven files report as failures with no test output at all, which reads like
 * seven broken test files rather than one environment limit:
 *
 *     ℹ tests 7
 *     ℹ pass 0
 *     ℹ fail 7
 *
 * Running each file DIRECTLY executes its tests in the process: no runner child, no pipe. `node:test`
 * still provides `describe`/`it`, still aggregates, and the file's exit code is still non-zero when an
 * assertion fails -- which is all a gate needs. This is the same runner the sibling `base-swap-indexer`
 * uses, for the same reason, and it was added here after the real Base Sepolia deployment made the
 * difference between "the suite passes" and "the suite cannot run" matter.
 *
 * `npm test` still uses `node --test` for machines where that works; this is the variant for the sandbox.
 *
 * Usage: node tools/run-tests.mjs
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const testDir = join(project, 'test');

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts') || name.endsWith('.test.mjs'))
  .sort();

if (files.length === 0) {
  console.error('No test files found in test/. That is a failure, not a pass.');
  process.exit(1);
}

const failed = [];

for (const file of files) {
  console.log(`\n${'='.repeat(72)}\n${file}\n${'='.repeat(72)}`);
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-strip-types', join(testDir, file)], {
    stdio: 'inherit',
    cwd: project,
    // Both spellings: a localhost call sent through the SOCKS proxy disappears silently.
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
  });
  if (result.status !== 0) failed.push(file);
}

console.log(`\n${'='.repeat(72)}`);
console.log(`${files.length - failed.length}/${files.length} test files passed`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.join(', ')}`);
  process.exit(failed.length);
}
console.log('all green');
