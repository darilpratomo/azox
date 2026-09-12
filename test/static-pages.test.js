import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPage } from '../core/build.js';
import { parseAzox } from '../core/compiler/parser.js';
import { compileToModule } from '../core/compiler/compileToJs.js';

// A page with no bindings and no listeners arrives complete from the
// build, so it needs no module at all. Shipping one means downloading a
// render() nobody calls — and the runtime with it.

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'azox-static-'));
  mkdirSync(join(dir, 'pages'), { recursive: true });
  mkdirSync(join(dir, 'components'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '2.1.0', type: 'module' }));

  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content);
  }

  return dir;
}

test('a page with no bindings references no module and none is written', () => {
  const dir = project({ 'pages/index.azox': '<main><h1>Plain</h1></main>' });

  try {
    const result = buildPage(dir, 'index');
    const html = readFileSync(result.htmlPath, 'utf8');

    assert.match(html, /<h1>Plain<\/h1>/, 'the markup still arrives complete');
    assert.doesNotMatch(html, /page\.client\.js/);
    assert.equal(existsSync(result.clientPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a page with a listener still gets its module', () => {
  const dir = project({
    'pages/index.azox': `<script>
  import { signal } from 'azox/reactivity';
  const n = signal(0);
</script>
<button on:click={() => n.set(n() + 1)}>{n()}</button>`,
  });

  try {
    const result = buildPage(dir, 'index');

    assert.match(readFileSync(result.htmlPath, 'utf8'), /page\.client\.js/);
    assert.ok(existsSync(result.clientPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The site's pages each hydrated for one reason: a version badge read
// from package.json, which cannot change after the build. Folding it
// made fourteen of sixteen pages static.
test('an expression reading only build-time constants needs no effect', () => {
  const dir = project({
    'pages/index.azox': `<script>
  import pkg from '../package.json' with { type: 'json' };
</script>
<p>v{pkg.version}</p>`,
  });

  try {
    const result = buildPage(dir, 'index');

    assert.match(readFileSync(result.htmlPath, 'utf8'), /<p>v2\.1\.0<\/p>/);
    assert.equal(existsSync(result.clientPath), false, 'a constant is not a binding');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a constant beside a real binding is folded, the binding kept', () => {
  const dir = project({
    'pages/index.azox': `<script>
  import { signal } from 'azox/reactivity';
  import pkg from '../package.json' with { type: 'json' };
  const n = signal(0);
</script>
<p on:click={() => n.set(n() + 1)}>v{pkg.version} {n()}</p>`,
  });

  try {
    const code = readFileSync(buildPage(dir, 'index').clientPath, 'utf8');

    assert.match(code, /"2\.1\.0"/, 'the constant is a literal');
    assert.doesNotMatch(code, /const pkg =/, 'and needs no object');
    assert.match(code, /String\(n\(\)\)/, 'the real binding survives');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Folding must not reach past what the build actually resolved.
test('a signal call is never treated as constant', () => {
  const code = compileToModule(
    parseAzox(`<script>
  import { signal } from 'azox/reactivity';
  const n = signal(1);
</script>
<p>{n()}</p>`),
    { runtimeSpecifier: './runtime.js', inlineModules: { pkg: { version: '1.0.0' } } }
  );

  assert.match(code, /effect\(/, 'a call could return anything');
});

test('an unknown name is never treated as constant', () => {
  const code = compileToModule(parseAzox('<p>{mystery}</p>'), {
    runtimeSpecifier: './runtime.js',
    inlineModules: { pkg: { version: '1.0.0' } },
  });

  assert.match(code, /effect\(/);
});

test('a constant read dynamically keeps the whole value', () => {
  const code = compileToModule(
    parseAzox(`<script>
  import { signal } from 'azox/reactivity';
  const i = signal(0);
</script>
<p>{pkg.names[i()]}</p>`),
    {
      runtimeSpecifier: './runtime.js',
      inlineModules: { pkg: { names: ['a', 'b'] } },
    }
  );

  assert.match(code, /"names":\["a","b"\]/, 'the index is unknown, so nothing can be folded');
  assert.match(code, /effect\(/);
});

test('a component that only prints a constant leaves the page static', () => {
  const dir = project({
    'components/Badge.azox': `<script>
  import pkg from '../package.json' with { type: 'json' };
</script>
<span>v{pkg.version}</span>`,
    'pages/index.azox': `<script>
  import Badge from '../components/Badge.azox';
</script>
<main><Badge /></main>`,
  });

  try {
    const result = buildPage(dir, 'index');

    assert.match(readFileSync(result.htmlPath, 'utf8'), /<span>v2\.1\.0<\/span>/);
    assert.equal(existsSync(result.clientPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A page that stops needing a module must not leave the old one behind,
// or a deployed site keeps loading it.
test('a module left by an earlier build is removed', () => {
  const dir = project({
    'pages/index.azox': `<script>
  import { signal } from 'azox/reactivity';
  const n = signal(0);
</script>
<button on:click={() => n.set(n() + 1)}>{n()}</button>`,
  });

  try {
    const first = buildPage(dir, 'index');
    assert.ok(existsSync(first.clientPath));

    writeFileSync(join(dir, 'pages/index.azox'), '<main>now static</main>');
    const second = buildPage(dir, 'index');

    assert.equal(existsSync(second.clientPath), false, 'the stale module must go');
    assert.doesNotMatch(readFileSync(second.htmlPath, 'utf8'), /page\.client\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
