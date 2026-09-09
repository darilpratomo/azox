// The build pipeline, independent of any CLI command: parse a page,
// server-render it, compile the hydration module, and write the
// result. `azox compile` runs it once; `azox dev` runs it on every
// change, so it returns data rather than printing.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, basename, relative, dirname } from 'node:path';

import { parseAzox } from './compiler/parser.js';
import { resolveComponents } from './compiler/resolveComponents.js';
import { compileToModule } from './compiler/compileToJs.js';
import { renderToHtml } from './renderer/renderToHtml.js';
import { collectRoutes, findRoute } from './routes.js';
import { createNodeResolver } from './nodeResolver.js';
import { ROOT_DIR } from './meta.js';
import { BuildError } from './buildError.js';

// Browsers can't resolve bare specifiers like "azox/reactivity", so
// the runtime is copied into the build and imports are rewritten to
// point at it. That also makes the output self-contained: any static
// host can serve it with no install step.
const RUNTIME_FILENAME = 'azox-runtime.js';

export const PAGES_DIR = 'pages';
export const BUILD_DIR = '.azox/build';

export { BuildError };

export function listRoutes(projectDir) {
  return collectRoutes(resolve(projectDir, PAGES_DIR));
}

// transformHtml lets the dev server inject its live-reload snippet
// without that ever reaching a production build.
export function buildRoute(projectDir, route, { transformHtml } = {}) {
  const { sourcePath, name } = route;
  const parsed = parseAzox(readFileSync(sourcePath, 'utf8'));

  // Components are inlined here, before either output is produced, so
  // the compiler and the renderer both see plain markup.
  const ast = resolveComponents(parsed, sourcePath, createNodeResolver());

  // SSR pass: render initial markup without touching browser DOM APIs.
  let html;
  try {
    html = renderToHtml(ast, buildServerScope(ast.script));
  } catch (error) {
    if (!(error instanceof BuildError)) throw error;
    throw new BuildError(`in ${PAGES_DIR}/${name}.azox: ${error.message}`);
  }

  const buildRoot = resolve(projectDir, BUILD_DIR);
  const outDir = resolve(buildRoot, route.outputDir);
  mkdirSync(outDir, { recursive: true });

  const clientPath = resolve(outDir, 'page.client.js');

  // Client pass: the same AST becomes a hydration module that wires
  // signals straight to DOM nodes once it runs in the browser.
  // The runtime lives at the build root, so a nested page reaches it
  // through its own prefix ("../", "../../", …).
  const runtimeSpecifier = `${route.assetPrefix}${RUNTIME_FILENAME}`;

  const clientModule = rewriteRuntimeImports(
    compileToModule(ast, {
      runtimeSpecifier,
      // The user's own relative imports were written next to the
      // page; the compiled module lives in .azox/build/, so they need
      // re-expressing from there.
      rewriteImports: (script) => rebaseImports(script, dirname(sourcePath), clientPath),
    }),
    runtimeSpecifier
  );

  assertValidJavaScript(clientModule, name);
  writeFileSync(clientPath, clientModule, 'utf8');

  // One runtime at the build root, shared by every page.
  const runtimePath = resolve(buildRoot, RUNTIME_FILENAME);
  copyFileSync(resolve(ROOT_DIR, 'core/reactivity/signal.js'), runtimePath);

  let document = wrapDocument(html, projectTitle(projectDir));
  if (transformHtml) document = transformHtml(document);

  const htmlPath = resolve(buildRoot, route.htmlPath);
  writeFileSync(htmlPath, document, 'utf8');

  return { ...route, htmlPath, clientPath, runtimePath };
}

export function buildAll(projectDir, options) {
  const routes = listRoutes(projectDir);

  if (!routes.length) {
    throw new BuildError(
      `no .azox pages found in ${PAGES_DIR}/ — run "azox create <name>" to start one`
    );
  }

  return routes.map((route) => buildRoute(projectDir, route, options));
}

// Builds a single page by route name or URL.
export function buildPage(projectDir, pageName, options) {
  const route = findRoute(listRoutes(projectDir), pageName);

  if (!route) {
    throw new BuildError(`page "${PAGES_DIR}/${pageName}.azox" not found in ${projectDir}`);
  }

  return buildRoute(projectDir, route, options);
}

// Rewrites the bare specifier a page's own <script> uses to the same
// path the compiler emitted for the runtime import.
function rewriteRuntimeImports(code, runtimeSpecifier) {
  return code.replace(/(['"])azox(?:\/reactivity)?\1/g, `'${runtimeSpecifier}'`);
}

// Re-expresses the relative imports in a page's <script> so they
// still resolve from the compiled module's directory. Lives here
// rather than in the compiler because it is a fact about where files
// land on disk, which the compiler deliberately knows nothing about.
function rebaseImports(script, sourceDir, outPath) {
  return script.replace(
    /(from\s+|import\s+)(['"])(\.[^'"]*)\2/g,
    (full, keyword, quote, specifier) => {
      let rebased = relative(dirname(outPath), resolve(sourceDir, specifier));
      if (!rebased.startsWith('.')) rebased = `./${rebased}`;
      return `${keyword}${quote}${rebased}${quote}`;
    }
  );
}

// A compiler must never write output it knows is broken. Parsing the
// emitted module catches a malformed expression here, with the page
// named, instead of leaving the user to find a syntax error in the
// browser console.
function assertValidJavaScript(code, pageName) {
  try {
    new Function(`return (async () => { ${stripModuleSyntax(code)} })`);
  } catch (error) {
    throw new BuildError(
      `compiling ${PAGES_DIR}/${pageName}.azox produced invalid JavaScript ` +
        `(${error.message}). This is an Azox bug — please report the page that caused it.`
    );
  }
}

// `new Function` cannot hold import/export statements, so they are
// removed before the syntax check. What remains is the generated
// body, which is where a malformed expression would land.
function stripModuleSyntax(code) {
  return code
    .replace(/^\s*import\s[^;]+;?\s*$/gm, '')
    .replace(/^\s*export\s+(?=function|const|let|class)/gm, '');
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

// The client module sits next to the page's index.html, so the src is
// the same for every route regardless of how deep it is.
function wrapDocument(bodyHtml, title) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
</head>
<body>
<div data-azox-root>${bodyHtml}</div>
<script type="module" src="./page.client.js"></script>
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
