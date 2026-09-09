// The build pipeline, independent of any CLI command: parse a page,
// server-render it, compile the hydration module, and write the
// result. `azox compile` runs it once; `azox dev` runs it on every
// change, so it returns data rather than printing.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';

import { parseAzox } from './compiler/parser.js';
import { resolveComponents } from './compiler/resolveComponents.js';
import { compileToModule } from './compiler/compileToJs.js';
import { renderToHtml } from './renderer/renderToHtml.js';
import { ROOT_DIR } from './meta.js';
import { BuildError } from './buildError.js';

// Browsers can't resolve bare specifiers like "azox/reactivity", so
// the runtime is copied into the build and imports are rewritten to
// point at it. That also makes the output self-contained: any static
// host can serve it with no install step.
const RUNTIME_FILENAME = 'azox-runtime.js';
const RUNTIME_SPECIFIER = `./${RUNTIME_FILENAME}`;

export const PAGES_DIR = 'pages';
export const BUILD_DIR = '.azox/build';

export { BuildError };

export function listPages(projectDir) {
  const dir = resolve(projectDir, PAGES_DIR);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((file) => file.endsWith('.azox'))
    .map((file) => basename(file, '.azox'))
    .sort();
}

// transformHtml lets the dev server inject its live-reload snippet
// without that ever reaching a production build.
export function buildPage(projectDir, pageName, { transformHtml } = {}) {
  const sourcePath = resolve(projectDir, PAGES_DIR, `${pageName}.azox`);

  if (!existsSync(sourcePath)) {
    throw new BuildError(`page "${PAGES_DIR}/${pageName}.azox" not found in ${projectDir}`);
  }

  const parsed = parseAzox(readFileSync(sourcePath, 'utf8'));

  // Components are inlined here, before either output is produced, so
  // the compiler and the renderer both see plain markup.
  const ast = resolveComponents(parsed, sourcePath);

  // SSR pass: render initial markup without touching browser DOM APIs.
  const html = renderToHtml(ast, buildServerScope(ast.script));

  const outDir = resolve(projectDir, BUILD_DIR);
  mkdirSync(outDir, { recursive: true });

  const clientPath = resolve(outDir, `${pageName}.client.js`);

  // Client pass: the same AST becomes a hydration module that wires
  // signals straight to DOM nodes once it runs in the browser.
  const clientModule = compileToModule(ast, {
    sourcePath,
    outPath: clientPath,
    runtimeSpecifier: RUNTIME_SPECIFIER,
  });
  writeFileSync(clientPath, rewriteRuntimeImports(clientModule), 'utf8');

  const runtimePath = resolve(outDir, RUNTIME_FILENAME);
  copyFileSync(resolve(ROOT_DIR, 'core/reactivity/signal.js'), runtimePath);

  let document = wrapDocument(html, pageName, projectTitle(projectDir));
  if (transformHtml) document = transformHtml(document);

  const htmlPath = resolve(outDir, `${pageName}.html`);
  writeFileSync(htmlPath, document, 'utf8');

  return { sourcePath, htmlPath, clientPath, runtimePath };
}

export function buildAll(projectDir, options) {
  const pages = listPages(projectDir);

  if (!pages.length) {
    throw new BuildError(
      `no .azox pages found in ${PAGES_DIR}/ — run "azox create <name>" to start one`
    );
  }

  return pages.map((page) => buildPage(projectDir, page, options));
}

function rewriteRuntimeImports(code) {
  return code.replace(/(['"])azox(?:\/reactivity)?\1/g, `'${RUNTIME_SPECIFIER}'`);
}

// Page title comes from the project's package.json name, falling back
// to the directory name.
function projectTitle(projectDir) {
  const pkgPath = resolve(projectDir, 'package.json');

  if (existsSync(pkgPath)) {
    try {
      const { name } = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (name) return name;
    } catch {
      // A malformed package.json shouldn't block a build.
    }
  }

  return basename(projectDir);
}

// Runs the page's <script> block in a server-side scope so SSR can
// evaluate the expressions the template references. The script is
// trusted project source, not user input — the same assumption any
// template engine's SSR step makes.
function buildServerScope(script) {
  // Strip imports: the server supplies its own `signal` stub rather
  // than loading the real reactive runtime.
  const body = script.replace(/^\s*import\s.+?;\s*$/gm, '');

  try {
    const fn = new Function('signal', `${body}\nreturn { ${declaredNames(body).join(', ')} };`);
    return fn(serverSignal);
  } catch (error) {
    throw new BuildError(`failed to evaluate the page's <script> block: ${error.message}`);
  }
}

// SSR needs only the current value, not reactivity, so `signal()` on
// the server is a plain boxed value.
function serverSignal(initial) {
  let value = initial;
  const read = () => value;
  read.set = (next) => {
    value = typeof next === 'function' ? next(value) : next;
  };
  read.peek = () => value;
  return read;
}

function declaredNames(script) {
  const names = [];
  const regex = /const\s+(\w+)\s*=/g;
  let match;
  while ((match = regex.exec(script))) names.push(match[1]);
  return names;
}

function wrapDocument(bodyHtml, pageName, title) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
</head>
<body>
<div data-azox-root>${bodyHtml}</div>
<script type="module" src="./${pageName}.client.js"></script>
</body>
</html>
`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
