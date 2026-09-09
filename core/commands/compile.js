// `azox compile` — compiles a .azox page into static HTML plus a
// client module that hydrates it with live signal bindings.
//
//   azox compile                  compiles pages/index.azox
//   azox compile --page=about     compiles pages/about.azox

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAzox } from '../compiler/parser.js';
import { compileToModule } from '../compiler/compileToJs.js';
import { renderToHtml } from '../renderer/renderToHtml.js';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function compileCommand({ flags }) {
  const pageName = flags.page || 'index';
  const sourcePath = resolve(rootDir, 'pages', `${pageName}.azox`);

  if (!existsSync(sourcePath)) {
    console.error(`Azox: page "${pageName}.azox" not found in pages/.`);
    process.exitCode = 1;
    return;
  }

  const source = readFileSync(sourcePath, 'utf8');
  const ast = parseAzox(source);

  // SSR pass: render initial markup without touching browser DOM APIs.
  const scope = buildServerScope(ast.script);
  const html = renderToHtml(ast, scope);

  const outDir = resolve(rootDir, '.azox', 'build');
  mkdirSync(outDir, { recursive: true });
  const clientPath = resolve(outDir, `${pageName}.client.js`);

  // Client pass: compile the same AST into a hydration module that
  // wires signals directly to DOM nodes once it runs in the browser.
  const clientModule = compileToModule(ast, { sourcePath, outPath: clientPath, rootDir });
  writeFileSync(clientPath, clientModule, 'utf8');

  const htmlPath = resolve(outDir, `${pageName}.html`);
  writeFileSync(htmlPath, wrapDocument(html, pageName), 'utf8');

  console.log('Azox Framework v0.0.1 - The Sound of Future Web');
  console.log(`Compiled pages/${pageName}.azox ->`);
  console.log(`  ${relative(htmlPath)}`);
  console.log(`  ${relative(clientPath)}`);
}

// Runs the page's <script> block in a server-side scope so SSR can
// evaluate the same expressions the template references. The script
// is trusted project source, not user input — same assumption any
// template engine's SSR step makes.
function buildServerScope(script) {
  // Strip import statements: the server provides its own `signal`
  // stub below instead of pulling in the real reactive runtime.
  const body = script.replace(/^\s*import\s.+?;\s*$/gm, '');
  const fn = new Function(
    'signal',
    `${body}\nreturn { ${extractDeclaredNames(body).join(', ')} };`
  );
  const { signal } = serverSignalStub();
  return fn(signal);
}

// Server-side renders only need the *current* value, not reactivity,
// so `signal()` on the server is a plain boxed value.
function serverSignalStub() {
  function signal(initial) {
    let value = initial;
    const read = () => value;
    read.set = (next) => {
      value = typeof next === 'function' ? next(value) : next;
    };
    read.peek = () => value;
    return read;
  }
  return { signal };
}

function extractDeclaredNames(script) {
  const names = [];
  const regex = /const\s+(\w+)\s*=/g;
  let match;
  while ((match = regex.exec(script))) names.push(match[1]);
  return names;
}

function wrapDocument(bodyHtml, pageName) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Azox Framework</title>
</head>
<body>
<div data-azox-root>${bodyHtml}</div>
<script type="module" src="./${pageName}.client.js"></script>
</body>
</html>
`;
}

function relative(path) {
  return path.replace(rootDir + '/', '');
}
