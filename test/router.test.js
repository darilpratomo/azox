// The client-side router: how the build wires it in, and the parts of
// its logic that can be checked without a browser.
//
// Navigation itself is exercised in a real browser during development;
// what is pinned here is that the router is opt-in, that it reaches
// every page when enabled, and that the module it loads is resolved
// against the right base — getting that wrong silently re-hydrated the
// previous page over the new one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAll } from '../core/build.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Builds a throwaway project and hands back its build directory.
function buildProject({ router = false, pages = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'azox-router-'));

  mkdirSync(join(dir, 'pages'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', type: 'module', ...(router ? { router: true } : {}) })
  );

  const files = Object.keys(pages).length ? pages : { 'index.azox': '<main>home</main>' };
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, 'pages', name)), { recursive: true });
    writeFileSync(join(dir, 'pages', name), source);
  }

  buildAll(dir);
  return { dir, build: join(dir, '.azox/build') };
}

test('the router is left out unless the project asks for it', () => {
  const { dir, build } = buildProject();

  try {
    assert.equal(existsSync(join(build, 'azox-router.js')), false);
    assert.doesNotMatch(readFileSync(join(build, 'index.html'), 'utf8'), /startRouter/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('"router": true copies the router and starts it', () => {
  const { dir, build } = buildProject({ router: true });

  try {
    assert.ok(existsSync(join(build, 'azox-router.js')));
    assert.match(readFileSync(join(build, 'index.html'), 'utf8'), /startRouter\(\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a nested page reaches the router through its own prefix', () => {
  const { dir, build } = buildProject({
    router: true,
    pages: {
      'index.azox': '<main>home</main>',
      'blog/post.azox': '<main>post</main>',
    },
  });

  try {
    assert.match(readFileSync(join(build, 'index.html'), 'utf8'), /'\.\/azox-router\.js'/);
    assert.match(
      readFileSync(join(build, 'blog/post/index.html'), 'utf8'),
      /'\.\.\/\.\.\/azox-router\.js'/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the router loads after the page module, so a page is interactive first', () => {
  const { dir, build } = buildProject({ router: true });

  try {
    const html = readFileSync(join(build, 'index.html'), 'utf8');
    assert.ok(
      html.indexOf('page.client.js') < html.indexOf('startRouter'),
      'the page module must come first'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the router source is valid JavaScript and exports startRouter', () => {
  const source = readFileSync(join(ROOT, 'core/router/navigate.js'), 'utf8');

  assert.match(source, /export function startRouter/);
  assert.doesNotThrow(() =>
    new Function(source.replace(/^import .+$/gm, '').replace(/^export /gm, ''))
  );
});

// Regression: the module was resolved against the address bar. Every
// route is a directory, so "/about" and "/about/" resolve
// "./page.client.js" to different files — the first landing on the
// root page's module, which then hydrated the previous page back over
// the one just navigated to.
test('the page module is resolved against a directory base', () => {
  const source = readFileSync(join(ROOT, 'core/router/navigate.js'), 'utf8');

  assert.match(source, /pageHref\.endsWith\('\/'\)/, 'a trailing slash must be ensured');
  assert.doesNotMatch(
    source,
    /new URL\(script\.getAttribute\('src'\), location\.href\)/,
    'resolving against location is what caused the bug'
  );
});

test('the router keeps no Node built-ins, so it runs in a browser', () => {
  const source = readFileSync(join(ROOT, 'core/router/navigate.js'), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s[^;]*['"]node:/m);
});
