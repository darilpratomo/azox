import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPage } from '../core/build.js';

// A component may carry a <head> block, which is what lets one shared
// layout hold the stylesheet, fonts and scripts every page needs.
// Before this, only a page could reach the document head, so each page
// repeated the same few lines and they drifted apart.

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'azox-head-'));
  mkdirSync(join(dir, 'pages'), { recursive: true });
  mkdirSync(join(dir, 'components'), { recursive: true });

  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content);
  }

  return dir;
}

const head = (path) => {
  const html = readFileSync(path, 'utf8');
  return html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
};

test("a component's head block reaches the document", () => {
  const dir = project({
    'components/Shell.azox': `<head>
  <link rel="stylesheet" href="/style.css" />
</head>

<div><slot /></div>`,
    'pages/index.azox': `<script>
  import Shell from '../components/Shell.azox';
</script>
<Shell><main>body</main></Shell>`,
  });

  try {
    const result = buildPage(dir, 'index');

    assert.match(head(result.htmlPath), /href="\/style\.css"/);
    // The slot still places the page's content inside the layout.
    assert.match(readFileSync(result.htmlPath, 'utf8'), /<div><main>body<\/main><\/div>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a component used twice contributes its head once', () => {
  const dir = project({
    'components/Box.azox': `<head>
  <link rel="stylesheet" href="/box.css" />
</head>

<div><slot /></div>`,
    'pages/index.azox': `<script>
  import Box from '../components/Box.azox';
</script>
<main><Box>a</Box><Box>b</Box></main>`,
  });

  try {
    const result = buildPage(dir, 'index');

    assert.equal(head(result.htmlPath).match(/box\.css/g)?.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a page and a component asking for the same file emit it once', () => {
  const dir = project({
    'components/Shell.azox': `<head>
  <link rel="stylesheet" href="/style.css" />
</head>

<div><slot /></div>`,
    'pages/index.azox': `<head>
  <link rel="stylesheet" href="/style.css" />
</head>

<script>
  import Shell from '../components/Shell.azox';
</script>
<Shell><main>body</main></Shell>`,
  });

  try {
    const result = buildPage(dir, 'index');

    assert.equal(head(result.htmlPath).match(/style\.css/g)?.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Two titles in one document is invalid, so a layout's is a default
// that the page — which knows its own subject — replaces.
test("a page's title replaces a layout's", () => {
  const dir = project({
    'components/Shell.azox': `<head>
  <title>Default</title>
  <meta name="description" content="default desc" />
</head>

<div><slot /></div>`,
    'pages/index.azox': `<head>
  <title>Home</title>
  <meta name="description" content="page desc" />
</head>

<script>
  import Shell from '../components/Shell.azox';
</script>
<Shell><main>body</main></Shell>`,
  });

  try {
    const result = buildPage(dir, 'index');
    const h = head(result.htmlPath);

    assert.equal(h.match(/<title>/g)?.length, 1);
    assert.match(h, /<title>Home<\/title>/);
    assert.doesNotMatch(h, /Default/);

    assert.equal(h.match(/name="description"/g)?.length, 1);
    assert.match(h, /content="page desc"/);
    assert.doesNotMatch(h, /default desc/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a layout's title is used when the page sets none", () => {
  const dir = project({
    'components/Shell.azox': `<head>
  <title>Default</title>
</head>

<div><slot /></div>`,
    'pages/index.azox': `<script>
  import Shell from '../components/Shell.azox';
</script>
<Shell><main>body</main></Shell>`,
  });

  try {
    const h = head(buildPage(dir, 'index').htmlPath);

    assert.equal(h.match(/<title>/g)?.length, 1);
    assert.match(h, /<title>Default<\/title>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Different meta tags must coexist; only a repeat of the same `name`
// is an override.
test('unrelated meta tags from both are kept', () => {
  const dir = project({
    'components/Shell.azox': `<head>
  <meta name="theme-color" content="#000" />
</head>

<div><slot /></div>`,
    'pages/index.azox': `<head>
  <meta name="description" content="page" />
</head>

<script>
  import Shell from '../components/Shell.azox';
</script>
<Shell><main>body</main></Shell>`,
  });

  try {
    const h = head(buildPage(dir, 'index').htmlPath);

    assert.match(h, /name="theme-color"/);
    assert.match(h, /name="description"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a component inside a conditional still contributes its head', () => {
  const dir = project({
    'components/Box.azox': `<head>
  <link rel="stylesheet" href="/box.css" />
</head>

<div><slot /></div>`,
    'pages/index.azox': `<script>
  import Box from '../components/Box.azox';
  const on = true;
</script>
<main>
  <if cond={on}>
    <Box>yes</Box>
  </if>
</main>`,
  });

  try {
    assert.match(head(buildPage(dir, 'index').htmlPath), /box\.css/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a nested component contributes its head too', () => {
  const dir = project({
    'components/Inner.azox': `<head>
  <link rel="stylesheet" href="/inner.css" />
</head>

<span>inner</span>`,
    'components/Outer.azox': `<head>
  <link rel="stylesheet" href="/outer.css" />
</head>

<script>
  import Inner from './Inner.azox';
</script>
<div><Inner /><slot /></div>`,
    'pages/index.azox': `<script>
  import Outer from '../components/Outer.azox';
</script>
<Outer><main>body</main></Outer>`,
  });

  try {
    const h = head(buildPage(dir, 'index').htmlPath);

    assert.match(h, /outer\.css/);
    assert.match(h, /inner\.css/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a page with no components keeps its own head unchanged', () => {
  const dir = project({
    'pages/index.azox': `<head>
  <title>Solo</title>
  <link rel="stylesheet" href="/a.css" />
</head>

<main>body</main>`,
  });

  try {
    const h = head(buildPage(dir, 'index').htmlPath);

    assert.match(h, /<title>Solo<\/title>/);
    assert.match(h, /a\.css/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
