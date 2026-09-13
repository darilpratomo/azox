// The build pipeline, independent of any CLI command: parse a page,
// server-render it, compile the hydration module, and write the
// result. `azox compile` runs it once; `azox dev` runs it on every
// change, so it returns data rather than printing.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { resolve, basename, relative, dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import { parseAzox } from './compiler/parser.js';
import { resolveComponents } from './compiler/resolveComponents.js';
import { compileToModule, STATIC_MARKER } from './compiler/compileToJs.js';
import { renderToHtml } from './renderer/renderToHtml.js';
import { parseImports } from './renderer/moduleBindings.js';
import { evaluateScript } from './renderer/serverScope.js';
import { escapeHtml } from './compiler/html.js';
import { collectRoutes, findRoute, resolveRoute, PAGE_EXTENSION } from './routes.js';
import { createNodeResolver } from './nodeResolver.js';
import { ROOT_DIR } from './meta.js';
import { BuildError } from './buildError.js';

// Browsers can't resolve bare specifiers like "azox/reactivity", so
// the runtime is copied into the build and imports are rewritten to
// point at it. That also makes the output self-contained: any static
// host can serve it with no install step.
const RUNTIME_FILENAME = 'azox-runtime.js';

// The client-side router is opt-in, via `router: true` in the project's
// package.json. Changing how every link behaves is not something a
// project should get without asking, and a site of plain documents is
// perfectly well served by ordinary navigation.
const ROUTER_FILENAME = 'azox-router.js';

export const PAGES_DIR = 'pages';
export const COMPONENTS_DIR = 'components';
export const PUBLIC_DIR = 'public';
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

  // Imports the script pulls in are loaded once: server rendering
  // evaluates against them, and the client module inlines them rather
  // than importing a path that is never deployed.
  const inlineModules = loadModules(ast.script, sourcePath, ast.componentImports ?? []);

  // SSR pass: render initial markup without touching browser DOM APIs.
  let html;
  try {
    html = renderToHtml(
      ast,
      buildServerScope(ast.script, inlineModules, route.params),
      inlineModules
    );
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
      // An import hoisted out of a component is relative to that
      // component's file, which is why the hook takes a path.
      rewriteImports: (script, from = sourcePath) =>
        rebaseImports(script, dirname(from), clientPath),
      inlineModules,
      routeParams: route.params ?? null,
    }),
    runtimeSpecifier
  );

  assertValidJavaScript(clientModule, name);
  // A page with no bindings and no listeners does nothing on load, so
  // the document does not reference its module — and without a reference
  // there is no reason to write it. The page still arrives complete,
  // because the markup was rendered during the build.
  const isStatic = clientModule.includes(STATIC_MARKER);

  if (isStatic) {
    // A previous build may have left one behind.
    if (existsSync(clientPath)) rmSync(clientPath);
  } else {
    writeFileSync(clientPath, clientModule, 'utf8');
  }

  // One runtime at the build root, shared by every page.
  const runtimePath = resolve(buildRoot, RUNTIME_FILENAME);
  copyFileSync(resolve(ROOT_DIR, 'core/reactivity/signal.js'), runtimePath);

  const router = routerEnabled(projectDir);
  if (router) {
    copyFileSync(resolve(ROOT_DIR, 'core/router/navigate.js'), resolve(buildRoot, ROUTER_FILENAME));
  }

  // A component's <head> block is merged in behind the page's own, so
  // a layout can carry the stylesheet and fonts every page needs while
  // the page keeps the last word on its title and description.
  const head = mergeHeads(ast.head, ast.componentHeads ?? []);

  let document = wrapDocument(html, projectTitle(projectDir), head, {
    routerSrc: router ? `${route.assetPrefix}${ROUTER_FILENAME}` : null,
    clientSrc: isStatic ? null : './page.client.js',
  });
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

  const results = expandTemplates(routes).map((route) =>
    buildRoute(projectDir, route, options)
  );
  const assets = copyPublicAssets(projectDir);
  removeStaleOutput(projectDir, results, assets);

  return results;
}

// Turns each template into the concrete routes it declares, leaving
// ordinary pages as they are. A template stands in for however many
// pages its routes() call names, and is never written at its own url.
function expandTemplates(routes) {
  const expanded = [];
  const seen = new Map();

  for (const route of routes) {
    if (!route.isTemplate) {
      expanded.push(route);
      continue;
    }

    for (const values of discoverRoutes(route)) {
      const resolved = resolveRoute(route, values);

      // Two entries producing the same url would have one silently
      // overwrite the other, leaving a page missing with no sign of it.
      const clash = seen.get(resolved.url);
      if (clash) {
        throw new BuildError(
          `${relative(process.cwd(), route.sourcePath)} declares ${resolved.url} twice — ` +
            `route parameters must be unique`
        );
      }

      seen.set(resolved.url, route);
      expanded.push(resolved);
    }
  }

  return expanded;
}

// Runs a template's <script> with `routes` bound to a collector, so
// the page declares its own pages from whatever data it imports.
//
// The script runs twice per page in total — once here to discover the
// list, then once per page to render it. That is the cost of letting
// the declaration be ordinary JavaScript rather than a separate
// manifest the author has to keep in step.
function discoverRoutes(route) {
  const source = readFileSync(route.sourcePath, 'utf8');
  const parsed = parseAzox(source);
  const where = `${PAGES_DIR}/${route.name}${PAGE_EXTENSION}`;

  if (!/\broutes\s*\(/.test(parsed.script)) {
    throw new BuildError(
      `in ${where}: a page with a [parameter] in its name must declare its pages — ` +
        `add routes([...]) to its <script> block, for example ` +
        `routes(posts.map((p) => ({ ${route.paramNames[0]}: p.${route.paramNames[0]} })))`
    );
  }

  const collected = [];
  const body = parsed.script.replace(/^\s*import\s.+?;?\s*$/gm, '');

  try {
    evaluateScript(
      body,
      [],
      [],
      loadModules(parsed.script, route.sourcePath),
      {
        routes: (list) => {
          collected.push(...normaliseRouteList(list, where, route.paramNames));
          return list;
        },
        // Discovery happens before any page exists, so params() has
        // nothing to report yet. Returning an empty object lets a
        // script that destructures it run without a special case.
        params: () => ({}),
      }
    );
  } catch (error) {
    if (error instanceof BuildError) throw error;
    throw new BuildError(`in ${where}: failed to work out which pages to build: ${error.message}`);
  }

  if (!collected.length) {
    throw new BuildError(
      `in ${where}: routes() was called with nothing, so no pages would be built. ` +
        `If the list can be empty, that is fine — but the build has nothing to write.`
    );
  }

  return collected;
}

// Each entry must supply every parameter the filename asks for. A
// missing one would otherwise land in a url as "undefined".
function normaliseRouteList(list, where, names) {
  if (!Array.isArray(list)) {
    throw new BuildError(
      `in ${where}: routes() needs an array of objects — got ${typeof list}`
    );
  }

  return list.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new BuildError(
        `in ${where}: routes() entry ${index} must be an object like { ${names[0]}: 'value' }`
      );
    }

    for (const name of names) {
      const value = entry[name];

      if (value === undefined || value === null || value === '') {
        throw new BuildError(
          `in ${where}: routes() entry ${index} is missing "${name}", ` +
            `which the filename asks for`
        );
      }

      if (String(value).includes('/')) {
        throw new BuildError(
          `in ${where}: routes() entry ${index} has "${name}" set to "${value}", ` +
            `which contains a "/" — a parameter fills one url segment`
        );
      }
    }

    return entry;
  });
}

// Deletes output belonging to pages that no longer exist. Without
// this, deleting a page leaves its built copy behind and a deployed
// site keeps serving it.
//
// Deliberately narrow: it only ever removes an index.html or a
// page.client.js that this build did not just write, and only inside
// the build directory. Anything else found there — a file copied from
// public/, something a user put there — is left alone.
function removeStaleOutput(projectDir, results, assets = []) {
  const buildRoot = resolve(projectDir, BUILD_DIR);
  if (!existsSync(buildRoot)) return;

  const written = new Set([
    ...results.flatMap((result) => [result.htmlPath, result.clientPath]),
    ...assets,
  ]);

  const generated = new Set(['index.html', 'page.client.js']);
  const emptied = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);
        // A directory left empty held only pages that are now gone.
        if (readdirSync(full).length === 0) emptied.push(full);
        continue;
      }

      if (generated.has(entry.name) && !written.has(full)) rmSync(full);
    }
  };

  walk(buildRoot);

  // Innermost first, so a nested route's directories go too.
  for (const dir of emptied.reverse()) {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  }
}

// Everything in public/ is copied to the build root untouched, so a
// stylesheet, font or image is referenced by the same path in source
// and in the built site: public/style.css -> /style.css.
// Files an editor or OS leaves behind, which should not be published.
//
// Every dotfile used to be skipped, which also dropped the ones a static
// host needs: .nojekyll tells GitHub Pages not to run Jekyll over the
// output, and .well-known/ is how a domain or certificate is verified.
const EDITOR_JUNK = new Set(['.DS_Store', 'Thumbs.db', '.git', 'node_modules']);

function isEditorJunk(name) {
  return EDITOR_JUNK.has(name);
}

export function copyPublicAssets(projectDir) {
  const publicDir = resolve(projectDir, PUBLIC_DIR);
  if (!existsSync(publicDir)) return [];

  const buildRoot = resolve(projectDir, BUILD_DIR);
  const copied = [];

  const walk = (dir, relativeDir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (isEditorJunk(entry.name)) continue;

      const from = join(dir, entry.name);
      const to = join(buildRoot, relativeDir, entry.name);

      if (entry.isDirectory()) {
        mkdirSync(to, { recursive: true });
        walk(from, join(relativeDir, entry.name));
      } else {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        copied.push(to);
      }
    }
  };

  walk(publicDir, '');
  return copied;
}

// Builds a single page by route name or URL.
export function buildPage(projectDir, pageName, options) {
  const routes = listRoutes(projectDir);
  const route = findRoute(routes, pageName);

  // A template cannot be built at its own url, so naming it builds
  // every page it declares — which is what the author means by
  // `azox compile --page=blog/[slug]`.
  if (route?.isTemplate) {
    return expandTemplates([route]).map((page) => buildRoute(projectDir, page, options));
  }

  if (route) return buildRoute(projectDir, route, options);

  // Not a file, so it may be one of the pages a template declares.
  // Expanding them is the only way to know.
  const generated = findRoute(
    expandTemplates(routes.filter((candidate) => candidate.isTemplate)),
    pageName
  );

  if (generated) return buildRoute(projectDir, generated, options);

  throw new BuildError(`page "${PAGES_DIR}/${pageName}.azox" not found in ${projectDir}`);
}

// Rewrites the bare specifier a page's own <script> uses to the same
// path the compiler emitted for the runtime import.
//
// Anchored to an import statement on its own line. Matching the bare
// string anywhere would rewrite data that merely contains it — a JSON
// import inlined into the module turned `"bin": {"azox": …}` into a
// path to the runtime.
function rewriteRuntimeImports(code, runtimeSpecifier) {
  return code.replace(
    /^([ \t]*import\s[\s\S]*?from\s+)(['"])azox(?:js)?(?:\/reactivity)?\2/gm,
    `$1'${runtimeSpecifier}'`
  );
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
function buildServerScope(script, modules = {}, params = null) {
  // Strip imports: the server supplies its own primitives rather than
  // loading the real reactive runtime, and anything else a script
  // imports was resolved by loadModules and is passed in.
  const body = script.replace(/^\s*import\s.+?;?\s*$/gm, '');

  // A dynamic page reads its own parameters through params(), and its
  // routes() call has already been answered by discovery — calling it
  // again here would collect the list a second time to no purpose.
  const extras = params
    ? { params: () => params, routes: (list) => list }
    : {};

  try {
    return evaluateScript(body, [], [], modules, extras);
  } catch (error) {
    if (error instanceof BuildError) throw error;
    throw new BuildError(`failed to evaluate the page's <script> block: ${error.message}`);
  }
}

// Resolves what a script's imports bring in, so server rendering sees
// the same values the browser will.
//
// Only JSON is loaded. A JSON import is synchronous and has no side
// effects, which suits a build step that must stay synchronous — and
// it covers the case this exists for: reading a version or some other
// constant out of package.json. Importing a .js module would mean
// executing project code during the build, and `require(esm)` only
// works from Node 22.12, below the floor this package declares.
function loadModules(script, sourcePath, componentImports = []) {
  // A component's hoisted import is relative to the component's own
  // file, so each is resolved against the path it came with.
  const imports = [
    ...parseImports(script).map((entry) => ({ ...entry, from: sourcePath })),
    ...componentImports.flatMap((entry) =>
      parseImports(entry.statement).map((parsed) => ({ ...parsed, from: entry.path }))
    ),
  ];

  if (!imports.length) return {};

  const bindings = {};

  for (const { specifier, bindings: names, from } of imports) {
    if (!specifier.endsWith('.json')) {
      throw new BuildError(
        `cannot import '${specifier}': a <script> block may import .azox components, ` +
          `'azox/reactivity', and .json files. Other modules are not available during ` +
          `server rendering.`
      );
    }

    const require = createRequire(from ? `file://${from}` : import.meta.url);

    let loaded;
    try {
      // require caches by resolved path, which is wrong for a build
      // that runs repeatedly in one process: `azox dev` would keep
      // serving the data as it was when the server started, so editing
      // a post changed nothing. Dropping the entry re-reads the file.
      delete require.cache[require.resolve(specifier)];
      loaded = require(specifier);
    } catch (error) {
      throw new BuildError(`cannot import '${specifier}': ${error.message.split('\n')[0]}`);
    }

    for (const { local, imported } of names) {
      if (imported === '*' || imported === 'default') bindings[local] = loaded;
      else bindings[local] = loaded[imported];
    }
  }

  return bindings;
}

// The client module sits next to the page's index.html, so the src is
// the same for every route regardless of how deep it is.
// Combines the <head> blocks a page and its components contributed.
//
// Components come first so the page can override them: a <title> or a
// <meta name="description"> set by a layout is a sensible default, and
// the page that knows its own subject should win. Identical lines are
// emitted once, so a layout and a page both asking for the same
// stylesheet do not produce it twice.
function mergeHeads(pageHead, componentHeads) {
  const seen = new Set();
  const lines = [];

  // A page's <title> and description replace a component's rather than
  // appearing alongside: two titles in one document is invalid.
  const pageTags = uniqueHeadTags(pageHead);

  for (const block of [...componentHeads, pageHead]) {
    for (const line of (block ?? '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const key = normaliseHeadLine(trimmed);
      if (seen.has(key)) continue;

      // Dropped in favour of the page's own.
      const tag = uniqueTagName(trimmed);
      if (tag && block !== pageHead && pageTags.has(tag)) continue;

      seen.add(key);
      lines.push(trimmed);
    }
  }

  return lines.join('\n');
}

// Tags a document may only hold one of, so a component's must give way
// to the page's. Keyed by tag name, plus the `name` of a <meta> — two
// different meta tags are fine, two descriptions are not.
function uniqueTagName(line) {
  const title = /^<title[\s>]/i.test(line);
  if (title) return 'title';

  const meta = line.match(/^<meta\s[^>]*name=["']([^"']+)["']/i);
  if (meta) return `meta:${meta[1].toLowerCase()}`;

  // Open Graph and Twitter cards key on `property`, not `name`. Without
  // this a shared default and a page's own tag both shipped, and a
  // scraper takes whichever it sees first.
  const property = line.match(/^<meta\s[^>]*property=["']([^"']+)["']/i);
  if (property) return `meta:${property[1].toLowerCase()}`;

  return null;
}

function uniqueHeadTags(head) {
  const names = new Set();

  for (const line of (head ?? '').split('\n')) {
    const tag = uniqueTagName(line.trim());
    if (tag) names.add(tag);
  }

  return names;
}

// Whitespace inside a tag should not make two identical links differ.
function normaliseHeadLine(line) {
  return line.replace(/\s+/g, ' ');
}

// A page's own <head> block wins over the fallback title, so a page
// can set its own <title>, stylesheets and meta tags.
function wrapDocument(
  bodyHtml,
  title,
  head = '',
  { routerSrc = null, clientSrc = './page.client.js' } = {}
) {
  const hasOwnTitle = /<title>/i.test(head);

  // The router is loaded after the page's own module, so a page is
  // interactive before navigation is enhanced.
  const router = routerSrc
    ? `\n<script type="module">import { startRouter } from '${routerSrc}'; startRouter();</script>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
${hasOwnTitle ? '' : `  <title>${escapeHtml(title)}</title>\n`}${head ? indent(head) + '\n' : ''}</head>
<body>
<div data-azox-root>${bodyHtml}</div>
${clientSrc ? `<script type="module" src="${clientSrc}"></script>` : ''}${router}
</body>
</html>
`;
}

// Reads `router` from the project's package.json. A malformed file is
// not this function's problem to report — the build reads it again for
// the page title and will surface anything wrong there.
function routerEnabled(projectDir) {
  const pkgPath = resolve(projectDir, 'package.json');
  if (!existsSync(pkgPath)) return false;

  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')).router === true;
  } catch {
    return false;
  }
}

function indent(block) {
  return block
    .split('\n')
    .map((line) => (line.trim() ? `  ${line.trim()}` : line))
    .join('\n');
}

