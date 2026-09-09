import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDevServer, RELOAD_PATH } from '../core/dev/server.js';
import { injectLiveReload } from '../core/dev/liveReload.js';

let rootDir;
let dev;
let baseUrl;

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'azox-server-'));
  mkdirSync(join(rootDir, 'nested'), { recursive: true });
  writeFileSync(join(rootDir, 'index.html'), '<h1>home</h1>');
  writeFileSync(join(rootDir, 'app.js'), 'export const x = 1;');
  writeFileSync(join(rootDir, 'style.css'), 'body { margin: 0 }');
  writeFileSync(join(rootDir, 'nested/index.html'), '<h1>nested</h1>');

  dev = createDevServer({ rootDir });
  await dev.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${dev.server.address().port}`;
});

after(async () => {
  await dev.close();
  rmSync(rootDir, { recursive: true, force: true });
});

beforeEach(() => {
  dev.setBuildError(null);
});

test('serves a file with its content', async () => {
  const res = await fetch(`${baseUrl}/index.html`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>home</h1>');
});

test('serves index.html for a directory request', async () => {
  const res = await fetch(`${baseUrl}/nested/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /nested/);
});

test('serves JavaScript with a module-compatible content type', async () => {
  const res = await fetch(`${baseUrl}/app.js`);
  assert.match(res.headers.get('content-type'), /text\/javascript/);
});

test('serves CSS with the right content type', async () => {
  const res = await fetch(`${baseUrl}/style.css`);
  assert.match(res.headers.get('content-type'), /text\/css/);
});

test('disables caching so edits are never stale', async () => {
  const res = await fetch(`${baseUrl}/index.html`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('returns 404 for a missing file', async () => {
  const res = await fetch(`${baseUrl}/nope.html`);
  assert.equal(res.status, 404);
});

test('refuses to serve files outside the root', async () => {
  const res = await fetch(`${baseUrl}/../../../../etc/passwd`);
  assert.ok(res.status >= 400, `expected an error status, got ${res.status}`);

  const body = await res.text();
  assert.doesNotMatch(body, /root:/, 'must never leak a file outside the served directory');
});

test('blocks traversal that arrives percent-encoded', async () => {
  const res = await fetch(`${baseUrl}/..%2f..%2f..%2fetc/passwd`);
  assert.ok(res.status >= 400);
  assert.doesNotMatch(await res.text(), /root:/);
});

test('serves the build error instead of stale output', async () => {
  dev.setBuildError(new Error('Azox parse error: <h1> is never closed'));

  const res = await fetch(`${baseUrl}/index.html`);
  assert.equal(res.status, 500);

  const body = await res.text();
  assert.match(body, /Build failed/);
  assert.match(body, /&lt;h1&gt; is never closed/, 'error text must be escaped');
});

test('recovers once the build error clears', async () => {
  dev.setBuildError(new Error('broken'));
  assert.equal((await fetch(`${baseUrl}/index.html`)).status, 500);

  dev.setBuildError(null);
  const res = await fetch(`${baseUrl}/index.html`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>home</h1>');
});

test('assets keep their real status while a build is broken', async () => {
  dev.setBuildError(new Error('broken'));

  const res = await fetch(`${baseUrl}/app.js`);
  assert.equal(res.status, 200, 'an asset must not be replaced by an HTML error page');
  assert.match(res.headers.get('content-type'), /javascript/);
});

test('the reload endpoint opens an event stream', async () => {
  const controller = new AbortController();

  try {
    const res = await fetch(`${baseUrl}${RELOAD_PATH}`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
  } finally {
    controller.abort();
  }
});

test('reload() pushes an event to a connected client', async () => {
  const controller = new AbortController();

  try {
    const res = await fetch(`${baseUrl}${RELOAD_PATH}`, { signal: controller.signal });
    const reader = res.body.getReader();

    await reader.read(); // the initial retry directive

    // Give the server a tick to register the client before signalling.
    await new Promise((done) => setTimeout(done, 50));
    dev.reload();

    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /event: reload/);
  } finally {
    controller.abort();
  }
});

test('injectLiveReload adds the client before </body>', () => {
  const html = injectLiveReload('<html><body><p>x</p></body></html>');

  assert.match(html, /EventSource/);
  assert.match(html, /<p>x<\/p>[\s\S]*<script>[\s\S]*<\/body>/);
});

test('injectLiveReload appends when there is no body tag', () => {
  assert.match(injectLiveReload('<p>bare</p>'), /<p>bare<\/p>[\s\S]*EventSource/);
});
