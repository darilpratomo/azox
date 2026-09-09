// Static file server for `azox dev`, with a Server-Sent Events
// channel used to tell connected browsers to reload.
//
// SSE rather than WebSockets: reload is a one-way signal, and SSE
// needs no handshake implementation, which keeps this dependency-free
// without carrying a protocol implementation.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve, sep } from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

export const RELOAD_PATH = '/__azox_reload';

export function createDevServer({ rootDir }) {
  const clients = new Set();

  // While a build is broken, stale output would look like the edit
  // simply didn't apply. Serving the error instead makes the actual
  // problem visible in the browser.
  let buildError = null;

  const server = createServer(async (req, res) => {
    if (req.url === RELOAD_PATH) {
      openReloadStream(req, res, clients);
      return;
    }

    if (buildError && isDocumentRequest(req.url)) {
      send(res, 500, 'text/html; charset=utf-8', errorPage(buildError));
      return;
    }

    await serveFile(req, res, rootDir);
  });

  return {
    server,
    listen: (port, host) => new Promise((done) => server.listen(port, host, done)),
    setBuildError(error) {
      buildError = error;
    },
    reload() {
      for (const client of clients) client.write('event: reload\ndata: {}\n\n');
    },
    close() {
      for (const client of clients) client.end();
      clients.clear();
      return new Promise((done) => server.close(done));
    },
    get connections() {
      return clients.size;
    },
  };
}

// Only pages show the error overlay; assets keep their real status so
// a failed script doesn't turn into an HTML body.
function isDocumentRequest(url) {
  const path = new URL(url, 'http://localhost').pathname;
  return path.endsWith('/') || path.endsWith('.html') || !extname(path);
}

function openReloadStream(req, res, clients) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 500\n\n');

  clients.add(res);
  req.on('close', () => clients.delete(res));
}

async function serveFile(req, res, rootDir) {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const filePath = resolveWithinRoot(rootDir, requested);

  if (!filePath) {
    send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    return;
  }

  try {
    const target = (await stat(filePath)).isDirectory() ? join(filePath, 'index.html') : filePath;
    const body = await readFile(target);
    const type = MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';

    // Dev output changes constantly; never let the browser cache it.
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    send(res, 404, 'text/html; charset=utf-8', notFoundPage(requested));
  }
}

// Blocks path traversal: a request for ../../etc/passwd must not
// escape the served directory.
function resolveWithinRoot(rootDir, requestedPath) {
  const root = resolve(rootDir);
  const candidate = resolve(join(root, normalize(requestedPath)));

  return candidate === root || candidate.startsWith(root + sep) ? candidate : null;
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function notFoundPage(path) {
  return page('404', `<h1>404</h1><p>No file at <code>${escapeHtml(path)}</code></p>`);
}

function errorPage(error) {
  return page(
    'Build failed',
    `<h1>Build failed</h1><pre>${escapeHtml(error.message)}</pre>`,
    /* live */ true
  );
}

function page(title, body, live = false) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title} · Azox</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0; min-height: 100vh;
      display: grid; place-items: center;
      font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 2rem;
    }
    main { max-width: 60ch; }
    h1 { font-size: 1.2rem; margin: 0 0 .75rem; }
    pre {
      white-space: pre-wrap; margin: 0;
      padding: 1rem; border-radius: 8px;
      background: color-mix(in srgb, currentColor 8%, transparent);
    }
    code { background: color-mix(in srgb, currentColor 8%, transparent); padding: .1em .35em; border-radius: 4px; }
  </style>
</head>
<body>
  <main>${body}</main>
  ${live ? `<script>new EventSource('${RELOAD_PATH}').addEventListener('reload', () => location.reload());</script>` : ''}
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
