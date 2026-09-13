import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseAzox } from '../core/compiler/parser.js';
import { resolveComponents, ComponentError } from '../core/compiler/resolveComponents.js';
import { createNodeResolver } from '../core/nodeResolver.js';
import { compileToModule } from '../core/compiler/compileToJs.js';
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

  const resolved = resolveComponents(parseAzox(source), pagePath, createNodeResolver());
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

test('a component can declare its own state', () => {
  writeComponent(
    'Stateful.azox',
    `<script>
  const n = 5;
</script>
<p>{n}</p>`
  );

  assert.equal(
    renderPage(`<script>
  import Stateful from '../components/Stateful.azox';
</script>
<main><Stateful /></main>`),
    '<main><p>5</p></main>'
  );
});

// Each use of a stateful component gets a scope of its own, so its
// declarations cannot collide with another use of the same component.
test('two uses of a stateful component get separate scopes', () => {
  writeComponent(
    'Counter.azox',
    `<script>
  import { signal } from 'azox/reactivity';
  const { label } = props();
  const count = signal(0);
</script>
<span>{label}:{count()}</span>`
  );

  const source = `<script>
  import Counter from '../components/Counter.azox';
</script>
<main><Counter label="A" /><Counter label="B" /></main>`;

  const pagePath = join(dir, 'pages/index.azox');
  writeFileSync(pagePath, source);

  const resolved = resolveComponents(parseAzox(source), pagePath, createNodeResolver());
  const js = compileToModule(resolved, { runtimeSpecifier: './runtime.js' });

  assert.equal(
    (js.match(/const count = signal\(0\);/g) ?? []).length,
    2,
    'each use declares its own count'
  );
  assert.equal((js.match(/\(\(label\) => \{/g) ?? []).length, 2, 'each use gets its own scope');
});

test('a stateful component server-renders its initial state', () => {
  assert.equal(
    renderPage(`<script>
  import Counter from '../components/Counter.azox';
</script>
<main><Counter label="A" /><Counter label="B" /></main>`),
    '<main><span>A:0</span><span>B:0</span></main>'
  );
});

// A component's imports cannot live inside the scope function, so
// they are hoisted to the module.
test("a stateful component's imports are hoisted to the module", () => {
  const source = `<script>
  import Counter from '../components/Counter.azox';
</script>
<main><Counter label="A" /></main>`;

  const pagePath = join(dir, 'pages/index.azox');
  writeFileSync(pagePath, source);

  const resolved = resolveComponents(parseAzox(source), pagePath, createNodeResolver());
  const js = compileToModule(resolved, { runtimeSpecifier: './runtime.js' });

  // signal is merged into the runtime's import statement rather than
  // getting one of its own, so match the binding, not the whole line.
  const importAt = js.search(/^import \{[^}]*\bsignal\b[^}]*\} from/m);
  const scopeAt = js.indexOf('(label) => {');

  assert.ok(importAt !== -1, 'the signal import must survive');
  assert.ok(importAt < scopeAt, 'and must sit outside the scope function');
});

test('a component with no logic is still inlined, without a scope', () => {
  writeComponent(
    'Plain2.azox',
    `<script>
  const { text } = props();
</script>
<em>{text}</em>`
  );

  const source = `<script>
  import Plain2 from '../components/Plain2.azox';
</script>
<main><Plain2 text="hi" /></main>`;

  const pagePath = join(dir, 'pages/index.azox');
  writeFileSync(pagePath, source);

  const resolved = resolveComponents(parseAzox(source), pagePath, createNodeResolver());
  const js = compileToModule(resolved, { runtimeSpecifier: './runtime.js' });

  assert.doesNotMatch(js, /=> \{[\s\S]*return _el/, 'no scope function is needed');
  assert.equal(renderToHtml(resolved, {}), '<main><em>hi</em></main>');
});

// Regression: an attribute expression that becomes constant once the
// caller's props are substituted was still wrapped in an effect. That
// made a page built only from such components look reactive, so it
// was hydrated — and hydration clears and rebuilds the DOM, which
// destroyed elements other scripts on the page were holding.
test('an attribute expression that folds to a constant creates no effect', () => {
  writeComponent(
    'NavLink.azox',
    `<script>
  const { current } = props();
</script>
<a href="/docs" class={current === 'docs' ? 'is-active' : ''}>Docs</a>`
  );

  const source = `<script>
  import NavLink from '../components/NavLink.azox';
</script>
<main><NavLink current="docs" /></main>`;

  const pagePath = join(dir, 'pages/index.azox');
  writeFileSync(pagePath, source);

  const resolved = resolveComponents(parseAzox(source), pagePath, createNodeResolver());
  const js = compileToModule(resolved, { runtimeSpecifier: './runtime.js' });

  assert.match(js, /setAttribute\("class", "is-active"\)/, 'the value should be folded');
  assert.doesNotMatch(js, /effect\(/, 'a constant needs no effect');
  assert.doesNotMatch(js, /innerHTML/, 'and the page should stay static');
});

test('folding picks the other branch when the prop differs', () => {
  const source = `<script>
  import NavLink from '../components/NavLink.azox';
</script>
<main><NavLink current="other" /></main>`;

  const pagePath = join(dir, 'pages/index.azox');
  writeFileSync(pagePath, source);

  const resolved = resolveComponents(parseAzox(source), pagePath, createNodeResolver());
  const js = compileToModule(resolved, { runtimeSpecifier: './runtime.js' });

  assert.match(js, /setAttribute\("class", ""\)/);
});

test('a genuinely dynamic attribute is still reactive', () => {
  writeComponent(
    'Toggle.azox',
    `<script>
  const { on } = props();
</script>
<a class={on() ? 'yes' : 'no'}>x</a>`
  );

  const source = `<script>
  import Toggle from '../components/Toggle.azox';
</script>
<main><Toggle on={flag} /></main>`;

  const pagePath = join(dir, 'pages/index.azox');
  writeFileSync(pagePath, source);

  const resolved = resolveComponents(parseAzox(source), pagePath, createNodeResolver());
  const js = compileToModule(resolved, { runtimeSpecifier: './runtime.js' });

  assert.match(js, /effect\(/, 'a call must not be folded away');
});

test('folding never runs a function call', () => {
  writeComponent(
    'Danger.azox',
    `<script>
  const { value } = props();
</script>
<a class={value}>x</a>`
  );

  const source = `<script>
  import Danger from '../components/Danger.azox';
</script>
<main><Danger value={sideEffect()} /></main>`;

  const pagePath = join(dir, 'pages/index.azox');
  writeFileSync(pagePath, source);

  const resolved = resolveComponents(parseAzox(source), pagePath, createNodeResolver());
  const js = compileToModule(resolved, { runtimeSpecifier: './runtime.js' });

  assert.match(js, /sideEffect\(\)/, 'the call must survive to runtime');
  assert.match(js, /effect\(/);
});

test('a stateful component works inside a loop', () => {
  assert.equal(
    renderPage(
      `<script>
  import Counter from '../components/Counter.azox';
</script>
<main><each item={rows()} as="r"><Counter label={r} /></each></main>`,
      { rows: () => ['a', 'b'] }
    ),
    '<main><!--[--><span>a:0</span><span>b:0</span><!--]--></main>'
  );
});

test('a stateful component works inside a conditional', () => {
  assert.equal(
    renderPage(
      `<script>
  import Counter from '../components/Counter.azox';
</script>
<main><if cond={ok()}><Counter label="x" /></if></main>`,
      { ok: () => true }
    ),
    '<main><!--[--><span>x:0</span><!--]--></main>'
  );
});

test('a component can loop over its own state', () => {
  writeComponent(
    'OwnList.azox',
    `<script>
  import { signal } from 'azox/reactivity';
  const items = signal(['p', 'q']);
</script>
<ul><each item={items()} as="x"><li>{x}</li></each></ul>`
  );

  assert.equal(
    renderPage(`<script>
  import OwnList from '../components/OwnList.azox';
</script>
<main><OwnList /></main>`),
    '<main><ul><!--[--><li>p</li><li>q</li><!--]--></ul></main>'
  );
});

test('a component can use computed', () => {
  writeComponent(
    'Doubled.azox',
    `<script>
  import { signal, computed } from 'azox/reactivity';
  const n = signal(3);
  const double = computed(() => n() * 2);
</script>
<p>{double()}</p>`
  );

  assert.equal(
    renderPage(`<script>
  import Doubled from '../components/Doubled.azox';
</script>
<main><Doubled /></main>`),
    '<main><p>6</p></main>'
  );
});

test('stateful components nest', () => {
  writeComponent(
    'Inner.azox',
    `<script>
  import { signal } from 'azox/reactivity';
  const m = signal(2);
</script>
<i>{m()}</i>`
  );
  writeComponent(
    'Outer.azox',
    `<script>
  import Inner from './Inner.azox';
  import { signal } from 'azox/reactivity';
  const n = signal(1);
</script>
<div><b>{n()}</b><Inner /></div>`
  );

  assert.equal(
    renderPage(`<script>
  import Outer from '../components/Outer.azox';
</script>
<main><Outer /></main>`),
    '<main><div><b>1</b><i>2</i></div></main>'
  );
});

// Regression: the page and a component both importing `signal`
// produced two identical import statements, which is a syntax error.
test('an import shared by page and component is declared once', () => {
  const source = `<script>
  import Counter from '../components/Counter.azox';
  import { signal } from 'azox/reactivity';

  const n = signal(1);
</script>
<main><Counter label="a" /><p>{n()}</p></main>`;

  const pagePath = join(dir, 'pages/index.azox');
  writeFileSync(pagePath, source);

  const resolved = resolveComponents(parseAzox(source), pagePath, createNodeResolver());
  const js = compileToModule(resolved, { runtimeSpecifier: 'azox/reactivity' });

  const declarations = [...js.matchAll(/^import .*\bsignal\b.*$/gm)];
  assert.equal(declarations.length, 1, 'signal must be imported exactly once');

  // And the output has to actually parse.
  assert.doesNotThrow(() =>
    new Function(js.replace(/^import .+$/gm, '').replace(/^export /gm, ''))
  );
});

// Regression: slot content was rendered against the component's scope,
// so a component's own declarations shadowed — or hid entirely —
// whatever the caller had referenced inside the tag.
test('slot content sees the scope it was written in', () => {
  writeComponent(
    'Frame.azox',
    `<script>
  import { signal } from 'azox/reactivity';
  const inner = signal('IN');
</script>
<div>{inner()}<slot /></div>`
  );

  assert.equal(
    renderPage(
      `<script>
  import Frame from '../components/Frame.azox';
  import { signal } from 'azox/reactivity';
  const outer = signal('OUT');
</script>
<Frame><b>{outer()}</b></Frame>`,
      { outer: () => 'OUT' }
    ),
    '<div>IN<b>OUT</b></div>'
  );
});

test('a component cannot shadow a name the slot content uses', () => {
  writeComponent(
    'Shadow.azox',
    `<script>
  import { signal } from 'azox/reactivity';
  const value = signal('component');
</script>
<div><slot /></div>`
  );

  assert.equal(
    renderPage(
      `<script>
  import Shadow from '../components/Shadow.azox';
</script>
<Shadow><b>{value()}</b></Shadow>`,
      { value: () => 'caller' }
    ),
    '<div><b>caller</b></div>',
    "the caller's binding must win inside its own markup"
  );
});

test('component errors are BuildErrors, so the CLI reports them plainly', () => {
  assert.ok(new ComponentError('x') instanceof BuildError);
});
