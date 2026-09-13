import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Without a declaration file a TypeScript consumer does not merely lose
// autocomplete — under `strict` their build fails outright with TS7016.
// Every major framework ships types; this asserts Azox does too, and
// that each entry point resolves its own.

test('every export condition carries a types entry', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  assert.ok(pkg.types, 'a top-level types field');
  assert.ok(existsSync(join(ROOT, pkg.types)), `${pkg.types} exists`);

  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    if (subpath === './package.json') continue;

    assert.equal(typeof entry, 'object', `${subpath} uses conditions`);
    assert.ok(entry.types, `${subpath} declares types`);
    assert.ok(entry.default, `${subpath} declares a default`);
    assert.ok(existsSync(join(ROOT, entry.types)), `${entry.types} exists`);
    assert.ok(existsSync(join(ROOT, entry.default)), `${entry.default} exists`);
  }
});

// A declaration that omits an export is worse than none: the editor
// says the name does not exist.
test('the runtime declaration covers every runtime export', async () => {
  const runtime = await import('../core/reactivity/signal.js');
  const declared = readFileSync(join(ROOT, 'core/reactivity/signal.d.ts'), 'utf8');

  const missing = Object.keys(runtime).filter(
    (name) => !new RegExp(`declare function ${name}\\b`).test(declared)
  );

  assert.deepEqual(missing, [], 'these are exported but undeclared');
});

test('the main declaration covers every main export', async () => {
  const main = await import('../core/index.js');
  const declared = readFileSync(join(ROOT, 'core/index.d.ts'), 'utf8');

  const missing = Object.keys(main).filter((name) => !declared.includes(name));

  assert.deepEqual(missing, [], 'these are exported but undeclared');
});

// computed() returns signal(undefined) at runtime, so `set` exists —
// but the deriving effect overwrites whatever you assign on its next
// run. Offering it in the types would invite a bug that looks like the
// framework losing writes.
test('computed is typed read-only', () => {
  const declared = readFileSync(join(ROOT, 'core/reactivity/signal.d.ts'), 'utf8');

  assert.match(declared, /interface ReadonlySignal<T>/);
  assert.match(declared, /function computed<T>\(fn: \(\) => T\): ReadonlySignal<T>/);

  const readonly = declared.slice(
    declared.indexOf('interface ReadonlySignal'),
    declared.indexOf('EffectHandle')
  );
  assert.doesNotMatch(readonly, /\bset\(/, 'ReadonlySignal must not offer set');
});
