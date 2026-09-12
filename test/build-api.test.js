import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPage, buildAll, listRoutes, BuildError } from '../core/build.js';

let projectDir;

// A page that genuinely hydrates: it reads a signal, so it has bindings
// and therefore a client module. A page with no bindings and no
// listeners ships none, which is correct but not what these tests are
// about.
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

test('listRoutes finds every page, sorted by url', () => {
  assert.deepEqual(
    listRoutes(projectDir).map((route) => route.url),
    ['/', '/about']
  );
});

test('listRoutes returns nothing when there is no pages directory', () => {
  const empty = mkdtempSync(join(tmpdir(), 'azox-empty-'));

  try {
    assert.deepEqual(listRoutes(empty), []);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('buildPage writes html, client module and runtime', () => {
  // A page that reads its signal, which is what a client module is for —
  // the shared fixtures are static and correctly ship none.
  const dir = mkdtempSync(join(tmpdir(), 'azox-live-'));

  try {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(
      join(dir, 'pages/index.azox'),
      page('<main><h1>Live</h1><button on:click={() => count.set(count() + 1)}>{count()}</button></main>')
    );

    const result = buildPage(dir, 'index');

    assert.match(readFileSync(result.htmlPath, 'utf8'), /<h1>Live<\/h1>/);
    assert.match(readFileSync(result.clientPath, 'utf8'), /createElement\("main"\)/);
    assert.match(readFileSync(result.runtimePath, 'utf8'), /export function signal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A page with nothing to hydrate does not reference a module, and none
// is written — a static page that downloads one pays for a render()
// nobody calls, and pulls in the runtime with it.
test('a static page ships no client module', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azox-plain-'));

  try {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages/index.azox'), '<main><h1>Plain</h1></main>');

    const result = buildPage(dir, 'index');
    const html = readFileSync(result.htmlPath, 'utf8');

    assert.match(html, /<h1>Plain<\/h1>/, 'the markup still arrives complete');
    assert.doesNotMatch(html, /page\.client\.js/, 'and references no module');
    assert.equal(existsSync(result.clientPath), false, 'none is written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildAll builds every page', () => {
  const results = buildAll(projectDir);
  const byUrl = Object.fromEntries(results.map((result) => [result.url, result]));

  assert.equal(results.length, 2);
  assert.match(readFileSync(byUrl['/'].htmlPath, 'utf8'), /<h1>Home<\/h1>/);
  assert.match(readFileSync(byUrl['/about'].htmlPath, 'utf8'), /<h1>About<\/h1>/);
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

// The compiler must never write JavaScript it knows is broken; the
// failure belongs at build time, not in the browser console.
test('a syntactically broken expression fails the build with the page named', () => {
  const broken = mkdtempSync(join(tmpdir(), 'azox-invalid-'));

  try {
    mkdirSync(join(broken, 'pages'), { recursive: true });
    writeFileSync(join(broken, 'pages/index.azox'), '<p>{ ( ) => }</p>');

    assert.throws(() => buildPage(broken, 'index'), (error) => {
      assert.ok(error instanceof BuildError);
      assert.match(error.message, /pages\/index\.azox/);
      assert.match(error.message, /not valid JavaScript/);
      return true;
    });

    assert.equal(
      existsSync(join(broken, '.azox/build/index.client.js')),
      false,
      'no output may be written when the build fails'
    );
  } finally {
    rmSync(broken, { recursive: true, force: true });
  }
});

test('an expression referencing an unknown name reports it clearly', () => {
  const broken = mkdtempSync(join(tmpdir(), 'azox-unknown-'));

  try {
    mkdirSync(join(broken, 'pages'), { recursive: true });
    writeFileSync(join(broken, 'pages/index.azox'), '<p>{missingVar}</p>');

    assert.throws(() => buildPage(broken, 'index'), /missingVar is not defined/);
  } finally {
    rmSync(broken, { recursive: true, force: true });
  }
});

test('an object literal in a handler compiles to valid JavaScript', () => {
  const project = mkdtempSync(join(tmpdir(), 'azox-literal-'));

  try {
    mkdirSync(join(project, 'pages'), { recursive: true });
    writeFileSync(
      join(project, 'pages/index.azox'),
      `<script>
  import { signal } from 'azox/reactivity';
  const user = signal({ name: 'a' });
</script>
<button on:click={() => user.set({ name: 'b' })}>Go</button>`
    );

    const result = buildPage(project, 'index');
    const code = readFileSync(result.clientPath, 'utf8');

    assert.match(code, /user\.set\(\{ name: 'b' \}\)/, 'the literal must survive intact');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// Regression: nested pages imported './azox-runtime.js' while the
// runtime sits at the build root, so every page below the top level
// 404'd on its runtime in the browser.
test('a nested page imports the runtime through its own prefix', () => {
  const nested = mkdtempSync(join(tmpdir(), 'azox-nested-'));

  try {
    mkdirSync(join(nested, 'pages/blog'), { recursive: true });
    writeFileSync(join(nested, 'pages/index.azox'), page('<main>{count()}</main>'));
    writeFileSync(join(nested, 'pages/blog/post.azox'), page('<main>{count()}</main>'));

    const results = buildAll(nested);
    const byUrl = Object.fromEntries(results.map((result) => [result.url, result]));

    assert.match(readFileSync(byUrl['/'].clientPath, 'utf8'), /from '\.\/azox-runtime\.js'/);
    assert.match(
      readFileSync(byUrl['/blog/post'].clientPath, 'utf8'),
      /from '\.\.\/\.\.\/azox-runtime\.js'/
    );

    // One runtime, at the root, shared by both.
    assert.ok(existsSync(join(nested, '.azox/build/azox-runtime.js')));
    assert.equal(existsSync(join(nested, '.azox/build/blog/azox-runtime.js')), false);
  } finally {
    rmSync(nested, { recursive: true, force: true });
  }
});

test('a nested page is written as a directory index', () => {
  const nested = mkdtempSync(join(tmpdir(), 'azox-nested-'));

  try {
    mkdirSync(join(nested, 'pages'), { recursive: true });
    writeFileSync(join(nested, 'pages/about.azox'), '<main>about</main>');

    const [result] = buildAll(nested);

    assert.equal(result.url, '/about');
    assert.ok(existsSync(join(nested, '.azox/build/about/index.html')));
  } finally {
    rmSync(nested, { recursive: true, force: true });
  }
});

test('buildPage accepts a url as well as a file name', () => {
  const result = buildPage(projectDir, '/about');
  assert.equal(result.url, '/about');
});

test('a page <head> block reaches the document head', () => {
  const project = mkdtempSync(join(tmpdir(), 'azox-head-'));

  try {
    mkdirSync(join(project, 'pages'), { recursive: true });
    writeFileSync(
      join(project, 'pages/index.azox'),
      `<head>
  <title>My Page</title>
  <link rel="stylesheet" href="/style.css" />
</head>

<main>hi</main>`
    );

    const [result] = buildAll(project);
    const html = readFileSync(result.htmlPath, 'utf8');

    assert.match(html, /<title>My Page<\/title>/);
    assert.match(html, /<link rel="stylesheet" href="\/style\.css" \/>/);
    assert.doesNotMatch(html, /<head>[\s\S]*<head>/, 'must not nest a second head');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('a page without a <head> still gets a title from the project name', () => {
  const project = mkdtempSync(join(tmpdir(), 'azox-nohead-'));

  try {
    mkdirSync(join(project, 'pages'), { recursive: true });
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'fallback-name' }));
    writeFileSync(join(project, 'pages/index.azox'), '<main>hi</main>');

    const [result] = buildAll(project);
    assert.match(readFileSync(result.htmlPath, 'utf8'), /<title>fallback-name<\/title>/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('public/ is copied to the build root, including subdirectories', () => {
  const project = mkdtempSync(join(tmpdir(), 'azox-public-'));

  try {
    mkdirSync(join(project, 'pages'), { recursive: true });
    mkdirSync(join(project, 'public/fonts'), { recursive: true });
    writeFileSync(join(project, 'pages/index.azox'), '<main>hi</main>');
    writeFileSync(join(project, 'public/style.css'), 'body{}');
    writeFileSync(join(project, 'public/fonts/font.woff2'), 'binary');

    buildAll(project);

    assert.ok(existsSync(join(project, '.azox/build/style.css')));
    assert.ok(existsSync(join(project, '.azox/build/fonts/font.woff2')));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('a project without public/ builds fine', () => {
  const project = mkdtempSync(join(tmpdir(), 'azox-nopublic-'));

  try {
    mkdirSync(join(project, 'pages'), { recursive: true });
    writeFileSync(join(project, 'pages/index.azox'), '<main>hi</main>');

    assert.doesNotThrow(() => buildAll(project));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// The build and the renderer each had their own idea of what a script
// could declare, and they drifted: pages could not use computed at
// all, and neither could see a function declaration.
test('a page script can use computed', () => {
  const project = mkdtempSync(join(tmpdir(), 'azox-scope-'));

  try {
    mkdirSync(join(project, 'pages'), { recursive: true });
    writeFileSync(
      join(project, 'pages/index.azox'),
      `<script>
  import { signal, computed } from 'azox/reactivity';
  const n = signal(3);
  const doubled = computed(() => n() * 2);
</script>
<p>{doubled()}</p>`
    );

    const [result] = buildAll(project);
    assert.match(readFileSync(result.htmlPath, 'utf8'), /<p>6<\/p>/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('a page script can declare a function and call it', () => {
  const project = mkdtempSync(join(tmpdir(), 'azox-scope-'));

  try {
    mkdirSync(join(project, 'pages'), { recursive: true });
    writeFileSync(
      join(project, 'pages/index.azox'),
      `<script>
  function triple(x) { return x * 3; }
</script>
<p>{triple(3)}</p>`
    );

    const [result] = buildAll(project);
    assert.match(readFileSync(result.htmlPath, 'utf8'), /<p>9<\/p>/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('a page script can use let and destructuring', () => {
  const project = mkdtempSync(join(tmpdir(), 'azox-scope-'));

  try {
    mkdirSync(join(project, 'pages'), { recursive: true });
    writeFileSync(
      join(project, 'pages/index.azox'),
      `<script>
  let name = 'Ada';
  const { role } = { role: 'Engineer' };
</script>
<p>{name}: {role}</p>`
    );

    const [result] = buildAll(project);
    assert.match(readFileSync(result.htmlPath, 'utf8'), /<p>Ada: Engineer<\/p>/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// Regression: deleting a page left its built output behind, so a
// deployed site kept serving a page that no longer existed.
test('output for a deleted page is removed on the next build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azox-stale-'));

  try {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages/index.azox'), '<main>home</main>');
    writeFileSync(join(dir, 'pages/gone.azox'), '<main>gone</main>');

    buildAll(dir);
    assert.ok(existsSync(join(dir, '.azox/build/gone/index.html')));

    rmSync(join(dir, 'pages/gone.azox'));
    buildAll(dir);

    assert.equal(
      existsSync(join(dir, '.azox/build/gone/index.html')),
      false,
      'the page is gone, so its output must be too'
    );
    assert.ok(existsSync(join(dir, '.azox/build/index.html')), 'the live page stays');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The cleanup deletes files, so what it must not touch matters as
// much as what it removes.
test('cleanup leaves public assets and the runtime alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azox-keep-'));

  try {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'public/static'), { recursive: true });
    writeFileSync(join(dir, 'pages/index.azox'), '<main>x</main>');
    writeFileSync(join(dir, 'public/style.css'), 'body{}');
    // A file a user placed themselves, with a name the build also uses.
    writeFileSync(join(dir, 'public/static/index.html'), '<p>mine</p>');

    buildAll(dir);
    buildAll(dir);

    assert.ok(existsSync(join(dir, '.azox/build/style.css')));
    assert.ok(existsSync(join(dir, '.azox/build/azox-runtime.js')));
    assert.ok(
      existsSync(join(dir, '.azox/build/static/index.html')),
      'a user\'s own index.html must survive'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

// Every dotfile in public/ used to be skipped, which also dropped the
// ones a static host needs: .nojekyll stops GitHub Pages running Jekyll
// over the output, and .well-known/ is how a domain is verified.
test('public/ publishes dotfiles a host needs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azox-dot-'));

  try {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'public/.well-known'), { recursive: true });
    writeFileSync(join(dir, 'pages/index.azox'), '<main>x</main>');
    writeFileSync(join(dir, 'public/.nojekyll'), '');
    writeFileSync(join(dir, 'public/CNAME'), 'example.com');
    writeFileSync(join(dir, 'public/.well-known/proof.txt'), 'ok');

    buildAll(dir);

    assert.ok(existsSync(join(dir, '.azox/build/.nojekyll')));
    assert.ok(existsSync(join(dir, '.azox/build/CNAME')));
    assert.ok(existsSync(join(dir, '.azox/build/.well-known/proof.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('editor and OS junk is still left behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azox-junk-'));

  try {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(join(dir, 'pages/index.azox'), '<main>x</main>');
    writeFileSync(join(dir, 'public/.DS_Store'), 'junk');
    writeFileSync(join(dir, 'public/Thumbs.db'), 'junk');

    buildAll(dir);

    assert.equal(existsSync(join(dir, '.azox/build/.DS_Store')), false);
    assert.equal(existsSync(join(dir, '.azox/build/Thumbs.db')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The stale-output sweep deletes generated files; a published dotfile is
// not one, and must survive a second build.
test('published dotfiles survive a rebuild', () => {
  const dir = mkdtempSync(join(tmpdir(), 'azox-dot2-'));

  try {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(join(dir, 'pages/index.azox'), '<main>x</main>');
    writeFileSync(join(dir, 'public/.nojekyll'), '');

    buildAll(dir);
    buildAll(dir);

    assert.ok(existsSync(join(dir, '.azox/build/.nojekyll')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
