// `azox compile` — compiles a .azox page into static HTML plus a
// client module that hydrates it with live signal bindings.
//
//   azox compile                  compiles pages/index.azox
//   azox compile --page=about     compiles pages/about.azox

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseAzox } from '../compiler/parser.js';
import { compileToModule } from '../compiler/compileToJs.js';
import { renderToHtml } from '../renderer/renderToHtml.js';
import { BANNER, ROOT_DIR } from '../meta.js';

// Browsers can't resolve bare specifiers like "azox/reactivity", so
// the runtime is copied into the build and imports are rewritten to
// point at it. That also makes .azox/build/ self-contained: it can be
// served by any static host with no install step.
const RUNTIME_FILENAME = 'azox-runtime.js';
const RUNTIME_SPECIFIER = `./${RUNTIME_FILENAME}`;

export function compileCommand({ flags }) {
  // Compilation is rooted at the user's project (cwd), not at the
  // framework checkout — `azox compile` inside a scaffolded app must
  // build that app's pages, not Azox's own.
  const projectDir = process.cwd();
  const pageName = flags.page || 'index';
  const sourcePath = resolve(projectDir, 'pages', `${pageName}.azox`);

  if (!existsSync(sourcePath)) {
    console.error(`Azox: page "pages/${pageName}.azox" not found in ${projectDir}.`);
    process.exitCode = 1;
    return;
  }

  const source = readFileSync(sourcePath, 'utf8');
  const ast = parseAzox(source);

  // SSR pass: render initial markup without touching browser DOM APIs.
  const scope = buildServerScope(ast.script);
  const html = renderToHtml(ast, scope);

  const outDir = resolve(projectDir, '.azox', 'build');
  mkdirSync(outDir, { recursive: true });
  const clientPath = resolve(outDir, `${pageName}.client.js`);

  // Client pass: compile the same AST into a hydration module that
  // wires signals directly to DOM nodes once it runs in the browser.
  const clientModule = compileToModule(ast, {
    sourcePath,
    outPath: clientPath,
    runtimeSpecifier: RUNTIME_SPECIFIER,
  });
  writeFileSync(clientPath, rewriteRuntimeImports(clientModule), 'utf8');

  const runtimePath = resolve(outDir, RUNTIME_FILENAME);
  copyFileSync(resolve(ROOT_DIR, 'core/reactivity/signal.js'), runtimePath);

  const htmlPath = resolve(outDir, `${pageName}.html`);
  writeFileSync(htmlPath, wrapDocument(html, pageName, projectTitle(projectDir)), 'utf8');

  console.log(BANNER);
  console.log(`Compiled pages/${pageName}.azox ->`);
  for (const path of [htmlPath, clientPath, runtimePath]) {
    console.log(`  ${relativeTo(projectDir, path)}`);
  }
}

// Rewrites "azox/reactivity" (and the root "azox" entry) to the
// runtime copy sitting next to the compiled module, so the output
// runs in a browser without an import map or a bundler.
function rewriteRuntimeImports(code) {
  return code.replace(/(['"])azox(?:\/reactivity)?\1/g, `'${RUNTIME_SPECIFIER}'`);
}

// Page title comes from the project's package.json name, falling
// back to the directory name.
function projectTitle(projectDir) {
  const pkgPath = resolve(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const { name } = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (name) return name;
    } catch {
      // Malformed package.json shouldn't block a build.
    }
  }
  return projectDir.split('/').pop();
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

function relativeTo(baseDir, path) {
  return path.startsWith(baseDir + '/') ? path.slice(baseDir.length + 1) : path;
}
