import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPage, BuildError } from '../core/build.js';

// A .azox <script> may import a .json file, which is how a page reads
// a version or some other constant out of package.json. The value is
// resolved once at build time: server rendering evaluates against it,
// and the client module inlines it rather than importing a path that
// is never deployed.

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'azox-json-'));
  mkdirSync(join(dir, 'pages'), { recursive: true });
  mkdirSync(join(dir, 'components'), { recursive: true });

  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content);
  }

  return dir;
}

test('a page reads a value from an imported json file', () => {
  const dir = project({
    'package.json': JSON.stringify({ name: 'app', version: '3.4.5', type: 'module' }),
    'pages/index.azox': `<script>
  import pkg from '../package.json' with { type: 'json' };
</script>
<p>v{pkg.version}</p>`,
  });

  try {
    const result = buildPage(dir, 'index');

    assert.match(readFileSync(result.htmlPath, 'utf8'), /<p>v3\.4\.5<\/p>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The import points outside the build directory at a file that is
// never deployed, so leaving it in the module 404s in the browser:
// the page renders on the server, then breaks on hydration.
test('the value is inlined rather than imported by the client module', () => {
  const dir = project({
    'package.json': JSON.stringify({ name: 'app', version: '1.2.3', type: 'module' }),
    // A listener, so the page has to hydrate and therefore has a module
    // to inspect — a page whose only expression is a constant ships none.
    'pages/index.azox': `<script>
  import { signal } from 'azox/reactivity';
  import pkg from '../package.json' with { type: 'json' };
  const n = signal(0);
</script>
<p on:click={() => n.set(n() + 1)}>v{pkg.version} {n()}</p>`,
  });

  try {
    const code = readFileSync(buildPage(dir, 'index').clientPath, 'utf8');

    assert.doesNotMatch(code, /package\.json/, 'no import may reach the browser');
    // The value is folded straight into the binding, so not even an
    // object for it is declared.
    assert.match(code, /"1\.2\.3"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Importing package.json for a version must not publish the rest of
// the file — an author's address included — to every visitor.
test('only the properties the page reads are inlined', () => {
  const dir = project({
    'package.json': JSON.stringify({
      name: 'app',
      version: '1.0.0',
      author: 'someone@example.com',
      type: 'module',
    }),
    'pages/index.azox': `<script>
  import { signal } from 'azox/reactivity';
  import pkg from '../package.json' with { type: 'json' };
  const n = signal(0);
</script>
<p on:click={() => n.set(n() + 1)}>{pkg.version} {n()}</p>`,
  });

  try {
    const code = readFileSync(buildPage(dir, 'index').clientPath, 'utf8');

    assert.doesNotMatch(code, /someone@example\.com/, 'an unread field must not ship');
    assert.match(code, /"1\.0\.0"/, 'the value the page reads is still there');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a value used as a whole object is kept whole', () => {
  const dir = project({
    'data.json': JSON.stringify({ a: 1, b: 2 }),
    'pages/index.azox': `<script>
  import data from '../data.json' with { type: 'json' };
  const keys = Object.keys(data).join(',');
</script>
<p>{keys}</p>`,
  });

  try {
    const result = buildPage(dir, 'index');

    assert.match(readFileSync(result.htmlPath, 'utf8'), /<p>a,b<\/p>/);
    assert.match(readFileSync(result.clientPath, 'utf8'), /"a":1,"b":2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: a component whose script was only an import had the
// import dropped, because a component with no other logic is inlined
// outright — leaving the name its markup referenced undefined.
test('a component may import json of its own', () => {
  const dir = project({
    'package.json': JSON.stringify({ name: 'app', version: '7.7.7', type: 'module' }),
    'components/Badge.azox': `<script>
  import pkg from '../package.json' with { type: 'json' };
</script>
<span>v{pkg.version}</span>`,
    'pages/index.azox': `<script>
  import { signal } from 'azox/reactivity';
  import Badge from '../components/Badge.azox';
  const n = signal(0);
</script>
<main on:click={() => n.set(n() + 1)}><Badge />{n()}</main>`,
  });

  try {
    const result = buildPage(dir, 'index');

    assert.match(readFileSync(result.htmlPath, 'utf8'), /<span>v7\.7\.7<\/span>/);

    // No import may reach the browser, and the value the component reads
    // is folded in rather than declared.
    const code = readFileSync(result.clientPath, 'utf8');
    assert.doesNotMatch(code, /import pkg/);
    assert.doesNotMatch(code, /package\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: the runtime specifier was rewritten by matching the
// bare string "azox" anywhere in the module, so an inlined package.json
// had `"bin": {"azox": …}` turned into a path to the runtime.
test('inlined data containing the runtime name is left alone', () => {
  const dir = project({
    'package.json': JSON.stringify({
      name: 'app',
      version: '1.0.0',
      bin: { azox: './bin/azox.js' },
      keywords: ['azox', 'framework'],
      type: 'module',
    }),
    // Indexed dynamically, so the value cannot be folded and the whole
    // object is declared — which is what puts the runtime's own name into
    // the module as data.
    'pages/index.azox': `<script>
  import { signal } from 'azox/reactivity';
  import pkg from '../package.json' with { type: 'json' };
  const i = signal(0);
</script>
<p on:click={() => i.set(i() + 1)}>{pkg.keywords[i()]}</p>`,
  });

  try {
    const result = buildPage(dir, 'index');
    const code = readFileSync(result.clientPath, 'utf8');

    assert.match(readFileSync(result.htmlPath, 'utf8'), /azox/);
    assert.match(code, /"keywords":\["azox","framework"\]/);
    // The real import is still rewritten to the copied runtime.
    assert.match(code, /from '\.\/azox-runtime\.js'/);
    assert.doesNotMatch(code, /from 'azox\/reactivity'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Loading a .js module would mean executing project code during the
// build, and require(esm) only works from Node 22.12 — below the floor
// this package declares. The limit is reported rather than leaving the
// author with "X is not defined" from the renderer.
test('importing a module that is not json is reported clearly', () => {
  const dir = project({
    'package.json': JSON.stringify({ name: 'app', type: 'module' }),
    'pages/helper.js': 'export const X = 1;',
    'pages/index.azox': `<script>
  import { X } from './helper.js';
</script>
<p>{X}</p>`,
  });

  try {
    assert.throws(() => buildPage(dir, 'index'), (error) => {
      assert.ok(error instanceof BuildError);
      assert.match(error.message, /cannot import '\.\/helper\.js'/);
      assert.match(error.message, /\.json/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing json file is reported with its specifier', () => {
  const dir = project({
    'package.json': JSON.stringify({ name: 'app', type: 'module' }),
    'pages/index.azox': `<script>
  import p from './nope.json' with { type: 'json' };
</script>
<p>{p.a}</p>`,
  });

  try {
    assert.throws(() => buildPage(dir, 'index'), /cannot import '\.\/nope\.json'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('named and aliased imports bind the right values', () => {
  const dir = project({
    'data.json': JSON.stringify({ title: 'Hello', count: 2 }),
    'pages/index.azox': `<script>
  import { title, count as total } from '../data.json' with { type: 'json' };
</script>
<p>{title} {total}</p>`,
  });

  try {
    assert.match(readFileSync(buildPage(dir, 'index').htmlPath, 'utf8'), /<p>Hello 2<\/p>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
