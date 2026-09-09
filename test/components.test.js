import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseAzox } from '../core/compiler/parser.js';
import { resolveComponents, ComponentError } from '../core/compiler/resolveComponents.js';
import { renderToHtml } from '../core/renderer/renderToHtml.js';
import { BuildError } from '../core/buildError.js';

let dir;

const writeComponent = (name, source) => writeFileSync(join(dir, 'components', name), source);

// Resolves a page written against the fixture's components and
// renders it, which is the clearest way to assert what a caller ends
// up with.
const renderPage = (source, scope = {}) => {
  const pagePath = join(dir, 'pages/index.azox');
  writeFileSync(pagePath, source);

  const resolved = resolveComponents(parseAzox(source), pagePath);
  return renderToHtml(resolved, scope);
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'azox-components-'));
  mkdirSync(join(dir, 'components'), { recursive: true });
  mkdirSync(join(dir, 'pages'), { recursive: true });

  writeComponent(
    'Card.azox',
    `<script>
  const { title, body } = props();
</script>

<article class="card"><h2>{title}</h2><p>{body}</p></article>`
  );

  writeComponent(
    'Layout.azox',
    `<script>
  const { heading } = props();
</script>

<section><header>{heading}</header><slot /></section>`
  );

  writeComponent('Plain.azox', '<hr>');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('a capitalised tag parses as a component', () => {
  const { markup } = parseAzox('<main><Card /></main>');
  assert.equal(markup.children[0].type, 'component');
});

test('a lowercase tag stays an element', () => {
  const { markup } = parseAzox('<main><section /></main>');
  assert.equal(markup.children[0].type, 'element');
});

test('component imports are collected from the script', () => {
  const { components } = parseAzox(`<script>
  import Card from './components/Card.azox';
  import { signal } from 'azox/reactivity';
</script>
<div>x</div>`);

  assert.deepEqual(components, { Card: './components/Card.azox' });
});

test('declared props are collected from props()', () => {
  const { props } = parseAzox(`<script>
  const { title, body } = props();
</script>
<div>x</div>`);

  assert.deepEqual(props, ['title', 'body']);
});

test('a component is inlined into its caller', () => {
  const html = renderPage(`<script>
  import Card from '../components/Card.azox';
</script>
<main><Card title="Hello" body="World" /></main>`);

  assert.equal(
    html,
    '<main><article class="card"><h2>Hello</h2><p>World</p></article></main>'
  );
});

test('the same component can be used more than once', () => {
  const html = renderPage(`<script>
  import Card from '../components/Card.azox';
</script>
<main><Card title="A" body="1" /><Card title="B" body="2" /></main>`);

  assert.match(html, /<h2>A<\/h2>/);
  assert.match(html, /<h2>B<\/h2>/);
});

test('an expression prop keeps the caller\'s expression', () => {
  const html = renderPage(
    `<script>
  import Card from '../components/Card.azox';
</script>
<main><Card title="Count" body={count()} /></main>`,
    { count: () => 42 }
  );

  assert.match(html, /<p>42<\/p>/);
});

test('a prop the caller omits renders as undefined rather than crashing', () => {
  const html = renderPage(`<script>
  import Card from '../components/Card.azox';
</script>
<main><Card title="Only title" /></main>`);

  assert.match(html, /<h2>Only title<\/h2>/);
});

test('slot receives the children nested in the caller', () => {
  const html = renderPage(`<script>
  import Layout from '../components/Layout.azox';
</script>
<Layout heading="Site"><p>inner</p></Layout>`);

  assert.equal(html, '<section><header>Site</header><p>inner</p></section>');
});

test('components nested inside a slot are resolved too', () => {
  const html = renderPage(`<script>
  import Layout from '../components/Layout.azox';
  import Card from '../components/Card.azox';
</script>
<Layout heading="Site"><Card title="In slot" body="x" /></Layout>`);

  assert.match(html, /<header>Site<\/header><article class="card"><h2>In slot<\/h2>/);
});

test('a component with no props works', () => {
  const html = renderPage(`<script>
  import Plain from '../components/Plain.azox';
</script>
<main><Plain /></main>`);

  assert.equal(html, '<main><hr></main>');
});

test('using a component without importing it is an error', () => {
  assert.throws(
    () => renderPage('<main><Missing /></main>'),
    (error) => {
      assert.ok(error instanceof ComponentError);
      assert.match(error.message, /<Missing> is used but never imported/);
      return true;
    }
  );
});

test('an undeclared prop is rejected and lists what is accepted', () => {
  assert.throws(
    () =>
      renderPage(`<script>
  import Card from '../components/Card.azox';
</script>
<main><Card title="x" subtitle="typo" /></main>`),
    /was given "subtitle".*It accepts: title, body/s
  );
});

test('an event handler on a component is not treated as a prop', () => {
  assert.doesNotThrow(() =>
    renderPage(`<script>
  import Card from '../components/Card.azox';
</script>
<main><Card title="x" body="y" on:click={handler} /></main>`)
  );
});

test('a missing component file is reported with its path', () => {
  assert.throws(
    () =>
      renderPage(`<script>
  import Ghost from '../components/Ghost.azox';
</script>
<main><Ghost /></main>`),
    /<Ghost> points at .*Ghost\.azox, which does not exist/
  );
});

test('a component that renders itself is caught instead of looping', () => {
  writeComponent(
    'Loop.azox',
    `<script>
  import Loop from './Loop.azox';
</script>
<div><Loop /></div>`
  );

  assert.throws(
    () =>
      renderPage(`<script>
  import Loop from '../components/Loop.azox';
</script>
<main><Loop /></main>`),
    /cycle detected/
  );
});

test('a component with logic beyond props() is rejected', () => {
  writeComponent(
    'Stateful.azox',
    `<script>
  const n = 5;
</script>
<p>{n}</p>`
  );

  assert.throws(
    () =>
      renderPage(`<script>
  import Stateful from '../components/Stateful.azox';
</script>
<main><Stateful /></main>`),
    /does not support/
  );
});

test('component errors are BuildErrors, so the CLI reports them plainly', () => {
  assert.ok(new ComponentError('x') instanceof BuildError);
});
