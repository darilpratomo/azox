import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPage, buildAll, listRoutes, BuildError } from '../core/build.js';

let projectDir;

const page = (body) => `<script>
  import { signal } from 'azox/reactivity';
  const count = signal(0);
</script>
${body}`;

before(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'azox-build-'));
  mkdirSync(join(projectDir, 'pages'), { recursive: true });
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: 'build-fixture', type: 'module' })
  );
  writeFileSync(join(projectDir, 'pages/index.azox'), page('<main><h1>Home</h1></main>'));
  writeFileSync(join(projectDir, 'pages/about.azox'), page('<main><h1>About</h1></main>'));
});

after(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

test('listRoutes finds every page, sorted by url', () => {
  assert.deepEqual(
    listRoutes(projectDir).map((route) => route.url),
    ['/', '/about']
  );
});

test('listRoutes returns nothing when there is no pages directory', () => {
  const empty = mkdtempSync(join(tmpdir(), 'azox-empty-'));

  try {
    assert.deepEqual(listRoutes(empty), []);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('buildPage writes html, client module and runtime', () => {
  const result = buildPage(projectDir, 'index');

  assert.match(readFileSync(result.htmlPath, 'utf8'), /<h1>Home<\/h1>/);
  assert.match(readFileSync(result.clientPath, 'utf8'), /createElement\("main"\)/);
  assert.match(readFileSync(result.runtimePath, 'utf8'), /export function signal/);
});

test('buildAll builds every page', () => {
  const results = buildAll(projectDir);
  const byUrl = Object.fromEntries(results.map((result) => [result.url, result]));

  assert.equal(results.length, 2);
  assert.match(readFileSync(byUrl['/'].htmlPath, 'utf8'), /<h1>Home<\/h1>/);
  assert.match(readFileSync(byUrl['/about'].htmlPath, 'utf8'), /<h1>About<\/h1>/);
});

test('transformHtml is applied to the written document', () => {
  const result = buildPage(projectDir, 'index', {
    transformHtml: (html) => html.replace('</body>', '<!--marker--></body>'),
  });

  assert.match(readFileSync(result.htmlPath, 'utf8'), /<!--marker--><\/body>/);
});

test('transformHtml does not run for a plain build', () => {
  const result = buildPage(projectDir, 'index');
  assert.doesNotMatch(readFileSync(result.htmlPath, 'utf8'), /marker|EventSource/);
});

test('buildPage reports a missing page as a BuildError', () => {
  assert.throws(() => buildPage(projectDir, 'ghost'), BuildError);
});

test('buildAll reports an empty project as a BuildError', () => {
  const empty = mkdtempSync(join(tmpdir(), 'azox-empty-'));

  try {
    mkdirSync(join(empty, 'pages'), { recursive: true });
    assert.throws(() => buildAll(empty), /no \.azox pages found/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

// The compiler must never write JavaScript it knows is broken; the
// failure belongs at build time, not in the browser console.
test('a syntactically broken expression fails the build with the page named', () => {
  const broken = mkdtempSync(join(tmpdir(), 'azox-invalid-'));

  try {
    mkdirSync(join(broken, 'pages'), { recursive: true });
    writeFileSync(join(broken, 'pages/index.azox'), '<p>{ ( ) => }</p>');

    assert.throws(() => buildPage(broken, 'index'), (error) => {
      assert.ok(error instanceof BuildError);
      assert.match(error.message, /pages\/index\.azox/);
      assert.match(error.message, /not valid JavaScript/);
      return true;
    });

    assert.equal(
      existsSync(join(broken, '.azox/build/index.client.js')),
      false,
      'no output may be written when the build fails'
    );
  } finally {
    rmSync(broken, { recursive: true, force: true });
  }
});

test('an expression referencing an unknown name reports it clearly', () => {
  const broken = mkdtempSync(join(tmpdir(), 'azox-unknown-'));

  try {
    mkdirSync(join(broken, 'pages'), { recursive: true });
    writeFileSync(join(broken, 'pages/index.azox'), '<p>{missingVar}</p>');

    assert.throws(() => buildPage(broken, 'index'), /missingVar is not defined/);
  } finally {
    rmSync(broken, { recursive: true, force: true });
  }
});

test('an object literal in a handler compiles to valid JavaScript', () => {
  const project = mkdtempSync(join(tmpdir(), 'azox-literal-'));

  try {
    mkdirSync(join(project, 'pages'), { recursive: true });
    writeFileSync(
      join(project, 'pages/index.azox'),
      `<script>
  import { signal } from 'azox/reactivity';
  const user = signal({ name: 'a' });
</script>
<button on:click={() => user.set({ name: 'b' })}>Go</button>`
    );

    const result = buildPage(project, 'index');
    const code = readFileSync(result.clientPath, 'utf8');

    assert.match(code, /user\.set\(\{ name: 'b' \}\)/, 'the literal must survive intact');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// Regression: nested pages imported './azox-runtime.js' while the
// runtime sits at the build root, so every page below the top level
// 404'd on its runtime in the browser.
test('a nested page imports the runtime through its own prefix', () => {
  const nested = mkdtempSync(join(tmpdir(), 'azox-nested-'));

  try {
    mkdirSync(join(nested, 'pages/blog'), { recursive: true });
    writeFileSync(join(nested, 'pages/index.azox'), page('<main>root</main>'));
    writeFileSync(join(nested, 'pages/blog/post.azox'), page('<main>{count()}</main>'));

    const results = buildAll(nested);
    const byUrl = Object.fromEntries(results.map((result) => [result.url, result]));

    assert.match(readFileSync(byUrl['/'].clientPath, 'utf8'), /from '\.\/azox-runtime\.js'/);
    assert.match(
      readFileSync(byUrl['/blog/post'].clientPath, 'utf8'),
      /from '\.\.\/\.\.\/azox-runtime\.js'/
    );

    // One runtime, at the root, shared by both.
    assert.ok(existsSync(join(nested, '.azox/build/azox-runtime.js')));
    assert.equal(existsSync(join(nested, '.azox/build/blog/azox-runtime.js')), false);
  } finally {
    rmSync(nested, { recursive: true, force: true });
  }
});

test('a nested page is written as a directory index', () => {
  const nested = mkdtempSync(join(tmpdir(), 'azox-nested-'));

  try {
    mkdirSync(join(nested, 'pages'), { recursive: true });
    writeFileSync(join(nested, 'pages/about.azox'), '<main>about</main>');

    const [result] = buildAll(nested);

    assert.equal(result.url, '/about');
    assert.ok(existsSync(join(nested, '.azox/build/about/index.html')));
  } finally {
    rmSync(nested, { recursive: true, force: true });
  }
});

test('buildPage accepts a url as well as a file name', () => {
  const result = buildPage(projectDir, '/about');
  assert.equal(result.url, '/about');
});

test('a parse error surfaces with the offending tag', () => {
  const broken = mkdtempSync(join(tmpdir(), 'azox-broken-'));

  try {
    mkdirSync(join(broken, 'pages'), { recursive: true });
    writeFileSync(join(broken, 'pages/index.azox'), '<main><h1>x</main>');

    assert.throws(() => buildPage(broken, 'index'), /<h1> is never closed/);
  } finally {
    rmSync(broken, { recursive: true, force: true });
  }
});
