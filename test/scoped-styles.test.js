import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPage } from '../core/build.js';
import { parseAzox } from '../core/compiler/parser.js';
import { scopeId, scopeCss, scopeAttribute } from '../core/compiler/scopeStyles.js';

// A component's CSS applies to that component and nothing else. The
// mechanism needs no runtime: selectors are rewritten to require an
// attribute, and the component's own elements carry it.

/* ---------- the parser ---------- */

// Before this, a <style> block was tokenised as markup and its braces
// were read as {expressions} — `.a { color: red }` failed the build
// with "Unexpected token ':'", an error about JavaScript pointing at a
// stylesheet.
test('a style block is taken out of the markup', () => {
  const ast = parseAzox('<style>.a { color: red }</style>\n<p class="a">hi</p>');

  assert.equal(ast.style, '.a { color: red }');
  assert.equal(ast.markup.name, 'p');
});

test('a file with no style block reports an empty one', () => {
  assert.equal(parseAzox('<p>hi</p>').style, '');
});

/* ---------- rewriting ---------- */

const id = scopeId('/components/Card.azox');
const attr = `[${scopeAttribute(id)}]`;

test('the same path always yields the same id', () => {
  assert.equal(scopeId('/components/Card.azox'), scopeId('/components/Card.azox'));
  assert.notEqual(scopeId('/components/Card.azox'), scopeId('/components/Other.azox'));
});

// Spacing is preserved throughout: rewriting selectors should not
// reformat the author's stylesheet.
test('each selector in a list is scoped', () => {
  assert.equal(scopeCss('.a, .b { margin: 0 }', id), `.a${attr}, .b${attr} { margin: 0 }`);
});

// `.card .title` styles the title, not the card, so the attribute
// belongs on the element actually being selected.
test('a descendant selector scopes its last compound', () => {
  assert.equal(scopeCss('.card .title { color: red }', id), `.card .title${attr} { color: red }`);
});

test('a pseudo-class stays after the attribute', () => {
  assert.equal(scopeCss('a:hover { color: blue }', id), `a${attr}:hover { color: blue }`);
});

test('rules inside @media are scoped, the condition is not', () => {
  const out = scopeCss('@media (min-width: 40rem) { .c { padding: 1rem } }', id);

  assert.match(out, /@media \(min-width: 40rem\)/);
  assert.match(out, new RegExp(`\\.c\\[data-azox-${id}\\]`));
});

// Scoping `from` and `to` would break the animation.
test('@keyframes steps are left alone', () => {
  const out = scopeCss('@keyframes spin { from { opacity: 0 } to { opacity: 1 } }', id);

  assert.doesNotMatch(out, /from\[/);
  assert.doesNotMatch(out, /to\[/);
});

test(':global escapes the scope', () => {
  assert.equal(scopeCss(':global(body) { margin: 0 }', id), 'body { margin: 0 }');
});

test('a comma inside a comment does not split the selector list', () => {
  const out = scopeCss('/* a, b */ .x { color: red }', id);
  assert.equal(out.match(/data-azox-/g)?.length, 1);
});

/* ---------- end to end ---------- */

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'azox-scope-'));
  mkdirSync(join(dir, 'pages'), { recursive: true });
  mkdirSync(join(dir, 'components'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));

  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content);
  }

  return dir;
}

test('a component ships its CSS and wears its attribute', () => {
  const dir = project({
    'components/Card.azox': `<style>
  .card { border: 1px solid red }
</style>

<article class="card"><slot /></article>`,
    'pages/index.azox': `<script>
  import Card from '../components/Card.azox';
</script>
<main><Card>inside</Card></main>`,
  });

  try {
    const html = readFileSync(buildPage(dir, 'index').htmlPath, 'utf8');
    const scope = scopeId(join(dir, 'components/Card.azox'));

    assert.match(html, new RegExp(`\\.card\\[data-azox-${scope}\\]`), 'the rule is scoped');
    assert.match(html, new RegExp(`<article class="card" data-azox-${scope}`), 'the element wears it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Slot content was written by the caller, so a component must not
// restyle markup it did not write.
test('slot content does not take the component scope', () => {
  const dir = project({
    'components/Card.azox': `<style>
  span { color: red }
</style>

<article><slot /></article>`,
    'pages/index.azox': `<script>
  import Card from '../components/Card.azox';
</script>
<main><Card><span>caller</span></Card></main>`,
  });

  try {
    const html = readFileSync(buildPage(dir, 'index').htmlPath, 'utf8');
    assert.doesNotMatch(html, /<span data-azox-/, 'the caller keeps its own scope');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a component used twice contributes its CSS once', () => {
  const dir = project({
    'components/Card.azox': `<style>
  .card { color: red }
</style>

<article class="card">x</article>`,
    'pages/index.azox': `<script>
  import Card from '../components/Card.azox';
</script>
<main><Card /><Card /></main>`,
  });

  try {
    const html = readFileSync(buildPage(dir, 'index').htmlPath, 'utf8');
    assert.equal(html.match(/\.card\[data-azox-/g)?.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two components do not collide', () => {
  const dir = project({
    'components/A.azox': `<style>
  .box { color: red }
</style>

<div class="box">a</div>`,
    'components/B.azox': `<style>
  .box { color: blue }
</style>

<div class="box">b</div>`,
    'pages/index.azox': `<script>
  import A from '../components/A.azox';
  import B from '../components/B.azox';
</script>
<main><A /><B /></main>`,
  });

  try {
    const html = readFileSync(buildPage(dir, 'index').htmlPath, 'utf8');
    const scopes = [...html.matchAll(/\.box\[data-azox-(\w+)\]/g)].map((m) => m[1]);

    assert.equal(scopes.length, 2, 'both rules survive');
    assert.notEqual(scopes[0], scopes[1], 'under different scopes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A page has no caller to be scoped against, and `body { … }` written
// in a page should mean what it says. The parser extracts it either
// way, so without this it was pulled out of the markup and then
// dropped — worse than the error it used to raise.
test("a page's own style block reaches the document, unscoped", () => {
  const dir = project({
    'pages/index.azox': `<style>
  body { margin: 0 }
  .lede { font-size: 1.2rem }
</style>

<main class="lede">hi</main>`,
  });

  try {
    const html = readFileSync(buildPage(dir, 'index').htmlPath, 'utf8');

    assert.match(html, /body \{ margin: 0 \}/, 'the rule survives');
    assert.doesNotMatch(html, /data-azox-a/, 'and is not scoped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a page style and a component style both arrive', () => {
  const dir = project({
    'components/Card.azox': `<style>
  .card { color: red }
</style>

<article class="card">x</article>`,
    'pages/index.azox': `<style>
  body { margin: 0 }
</style>

<script>
  import Card from '../components/Card.azox';
</script>
<main><Card /></main>`,
  });

  try {
    const html = readFileSync(buildPage(dir, 'index').htmlPath, 'utf8');

    assert.match(html, /body \{ margin: 0 \}/);
    assert.match(html, /\.card\[data-azox-/);
    assert.equal(html.match(/<style>/g)?.length, 1, 'one style tag, not two');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- literal blocks ---------- */

// A <text> block holds content exactly as written — that is its whole
// purpose. But the parser pulled the first <script>, <head> or <style>
// from anywhere in the source, so a code sample showing one was eaten:
// documenting a <style> block made the page's CSS that sample.
test('a style block inside <text> is left as content', () => {
  const ast = parseAzox('<main><text><style>.a { color: red }</style></text></main>');
  assert.equal(ast.style, '', 'the sample is not the page style');
});

test('a script block inside <text> is left as content', () => {
  const ast = parseAzox('<main><text><script>const x = 1;</script></text></main>');
  assert.equal(ast.script, '');
});

test('a head block inside <text> is left as content', () => {
  const ast = parseAzox('<main><text><head><title>T</title></head></text></main>');
  assert.equal(ast.head, '');
});

// The real blocks must still be found when a literal sample sits nearby.
test('a real style block is still found alongside a sample of one', () => {
  const ast = parseAzox(
    '<style>.real { color: blue }</style>\n<main><text><style>.sample { color: red }</style></text></main>'
  );

  assert.equal(ast.style, '.real { color: blue }');
});

test('the sample survives in the markup', () => {
  const ast = parseAzox('<main><text><style>.a { color: red }</style></text></main>');
  const rendered = JSON.stringify(ast.markup);

  assert.match(rendered, /\.a \{ color: red \}/, 'the sample is still there to render');
});
