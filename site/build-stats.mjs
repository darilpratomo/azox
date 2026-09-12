// Writes the numbers the home page shows, so they cannot drift from the
// truth the way "185 tests" and "~1 KB runtime" did.
//
// Both are measured, not typed: the test count comes from running the
// suite, the runtime size from gzipping the file the build copies.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SITE_DIR, '..');

function testCount() {
  // The runner reports a summary line; --test-reporter=tap keeps it
  // parseable regardless of the default reporter.
  // The same files `npm test` runs — a directory argument is resolved as
  // a module, not a glob.
  const files = readdirSync(resolve(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => `test/${name}`);

  const output = execFileSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...files],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );

  const pass = output.match(/^# pass (\d+)$/m);
  const fail = output.match(/^# fail (\d+)$/m);

  if (!pass) throw new Error('could not read the test count from the runner');
  if (fail && Number(fail[1]) > 0) {
    throw new Error(`${fail[1]} test(s) failing — the site must not advertise a number that includes them`);
  }

  return Number(pass[1]);
}

function runtimeBytes() {
  const source = readFileSync(resolve(ROOT, 'core/reactivity/signal.js'));
  return gzipSync(source, { level: 9 }).length;
}

const stats = {
  tests: testCount(),
  runtimeGzip: runtimeBytes(),
};

writeFileSync(resolve(SITE_DIR, 'stats.json'), `${JSON.stringify(stats, null, 2)}\n`);
console.log(`stats.json: ${stats.tests} tests, ${stats.runtimeGzip} B runtime gzipped`);
