import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPage, buildAll, listPages, BuildError } from '../core/build.js';

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

test('listPages finds every .azox page, sorted', () => {
  assert.deepEqual(listPages(projectDir), ['about', 'index']);
});

test('listPages returns nothing when there is no pages directory', () => {
  const empty = mkdtempSync(join(tmpdir(), 'azox-empty-'));

  try {
    assert.deepEqual(listPages(empty), []);
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

  assert.equal(results.length, 2);
  assert.match(readFileSync(results[0].htmlPath, 'utf8'), /<h1>About<\/h1>/);
  assert.match(readFileSync(results[1].htmlPath, 'utf8'), /<h1>Home<\/h1>/);
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
