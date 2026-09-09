import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectRoutes, findRoute } from '../core/routes.js';

let pagesDir;
let routes;

const page = (path) => {
  const full = join(pagesDir, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '<main>x</main>');
};

before(() => {
  pagesDir = mkdtempSync(join(tmpdir(), 'azox-routes-'));

  page('index.azox');
  page('about.azox');
  page('blog/index.azox');
  page('blog/first-post.azox');
  page('docs/guide/setup.azox');

  // Neither of these is a page.
  writeFileSync(join(pagesDir, 'notes.md'), 'not a page');
  mkdirSync(join(pagesDir, '.hidden'), { recursive: true });
  writeFileSync(join(pagesDir, '.hidden/secret.azox'), '<p>hidden</p>');

  routes = collectRoutes(pagesDir);
});

after(() => {
  rmSync(pagesDir, { recursive: true, force: true });
});

const urlOf = (name) => routes.find((route) => route.name === name)?.url;
const routeFor = (url) => routes.find((route) => route.url === url);

test('index.azox becomes the root route', () => {
  assert.equal(urlOf('index'), '/');
});

test('a top-level page becomes a single segment', () => {
  assert.equal(urlOf('about'), '/about');
});

test('a nested index names its directory', () => {
  assert.equal(urlOf('blog/index'), '/blog');
});

test('a nested page keeps its directory as a prefix', () => {
  assert.equal(urlOf('blog/first-post'), '/blog/first-post');
});

test('routes nest to any depth', () => {
  assert.equal(urlOf('docs/guide/setup'), '/docs/guide/setup');
});

test('non-.azox files are ignored', () => {
  assert.ok(!routes.some((route) => route.url.includes('notes')));
});

test('dot-directories are skipped', () => {
  assert.ok(!routes.some((route) => route.url.includes('secret')));
});

test('routes come back sorted by url', () => {
  const urls = routes.map((route) => route.url);
  assert.deepEqual(urls, [...urls].sort());
});

test('the root page writes to index.html', () => {
  assert.equal(routeFor('/').htmlPath, 'index.html');
});

test('a nested page writes to a directory index so the url stays clean', () => {
  assert.equal(routeFor('/about').htmlPath, 'about/index.html');
  assert.equal(routeFor('/blog/first-post').htmlPath, 'blog/first-post/index.html');
});

test('assetPrefix climbs back to the build root', () => {
  assert.equal(routeFor('/').assetPrefix, './');
  assert.equal(routeFor('/about').assetPrefix, '../');
  assert.equal(routeFor('/docs/guide/setup').assetPrefix, '../../../');
});

test('a route is found by its file name', () => {
  assert.equal(findRoute(routes, 'blog/first-post').url, '/blog/first-post');
});

test('a route is found by its url', () => {
  assert.equal(findRoute(routes, '/about').name, 'about');
});

test('a url with surrounding slashes still matches', () => {
  assert.equal(findRoute(routes, '/about/').name, 'about');
});

test('an unknown name finds nothing', () => {
  assert.equal(findRoute(routes, 'nope'), undefined);
});

test('a missing pages directory yields no routes', () => {
  assert.deepEqual(collectRoutes(join(pagesDir, 'does-not-exist')), []);
});
