import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAzox } from '../core/compiler/parser.js';
import { compileToModule } from '../core/compiler/compileToJs.js';
import { renderToHtml } from '../core/renderer/renderToHtml.js';

const sig = (value) => {
  const read = () => value;
  read.set = (next) => {
    value = typeof next === 'function' ? next(value) : next;
  };
  read.peek = () => value;
  return read;
};

const compile = (source) =>
  compileToModule(parseAzox(source), { runtimeSpecifier: './runtime.js' });

/* ---------- fragments ---------- */

// A component had to have exactly one root, so returning a pair of
// <li>s meant wrapping them in a <div> that made the HTML invalid.
test('several roots parse into one fragment', () => {
  const { markup } = parseAzox('<li>a</li><li>b</li>');

  assert.equal(markup.type, 'fragment');
  assert.equal(markup.children.length, 2);
});

test('a single root is still an element, not a fragment', () => {
  assert.equal(parseAzox('<main>one</main>').markup.type, 'element');
});

test('a fragment renders its roots with nothing around them', () => {
  assert.equal(renderToHtml(parseAzox('<li>a</li><li>b</li>'), {}), '<li>a</li><li>b</li>');
});

test('text between roots is kept', () => {
  assert.equal(renderToHtml(parseAzox('<b>a</b> and <b>b</b>'), {}), '<b>a</b> and <b>b</b>');
});

test('a fragment compiles to a DocumentFragment', () => {
  const code = compile('<li>a</li><li>b</li>');

  assert.match(code, /createDocumentFragment/);
  assert.equal(code.match(/createElement\("li"\)/g)?.length, 2);
});

test('a multi-root component lands directly in its caller', () => {
  const { markup } = parseAzox('<p>{a}</p><p>{b}</p>');
  assert.equal(renderToHtml({ markup }, { a: 'x', b: 'y' }), '<p>x</p><p>y</p>');
});

test('trailing junk is still an error', () => {
  assert.throws(() => parseAzox('<div class="x"'), /unterminated tag/);
});

/* ---------- bind: ---------- */

test('bind:value sets the property and listens for input', () => {
  const code = compile(`<script>
  import { signal } from 'azox/reactivity';
  const draft = signal('');
</script>
<input bind:value={draft} />`);

  assert.match(code, /\.value = draft\(\)/, 'the element follows the signal');
  assert.match(code, /addEventListener\("input"/, 'and the signal follows the element');
  assert.match(code, /draft\.set\(/);
});

// setAttribute("value") sets only the initial value, so after a user
// types, writing the attribute changes nothing they can see.
test('value is assigned as a property, never as an attribute', () => {
  const code = compile(`<script>
  import { signal } from 'azox/reactivity';
  const draft = signal('');
</script>
<input bind:value={draft} />`);

  assert.doesNotMatch(code, /setAttribute\("value"/);
});

test('a checkbox binds checked and listens for change', () => {
  const code = compile(`<script>
  import { signal } from 'azox/reactivity';
  const agree = signal(false);
</script>
<input type="checkbox" bind:checked={agree} />`);

  assert.match(code, /\.checked = agree\(\)/);
  assert.match(code, /addEventListener\("change"/, 'a checkbox reports change, not input');
  assert.match(code, /_e\.target\.checked/, 'and reports checked, not value');
});

test('a select listens for change', () => {
  const code = compile(`<script>
  import { signal } from 'azox/reactivity';
  const pick = signal('a');
</script>
<select bind:value={pick}><option value="a">A</option></select>`);

  assert.match(code, /addEventListener\("change"/);
});

// A number input reports a string, so arithmetic on the signal would
// silently concatenate: 5 + 1 becoming "51".
test('a number input is read as a number', () => {
  const code = compile(`<script>
  import { signal } from 'azox/reactivity';
  const qty = signal(1);
</script>
<input type="number" bind:value={qty} />`);

  assert.match(code, /valueAsNumber/);
});

// Binding has to write back, which a value cannot do.
test('bind: rejects a called signal', () => {
  assert.throws(
    () =>
      compile(`<script>
  import { signal } from 'azox/reactivity';
  const draft = signal('');
</script>
<input bind:value={draft()} />`),
    /needs a signal by name/
  );
});

test('bind: rejects an arbitrary expression', () => {
  assert.throws(() => compile('<input bind:value={a + b} />'), /needs a signal by name/);
});

/* ---------- bind: on the server ---------- */

test('a bound value renders as the plain attribute', () => {
  assert.equal(
    renderToHtml(parseAzox('<input bind:value={name} />'), { name: sig('Ada') }),
    '<input value="Ada">'
  );
});

// checked="false" is still checked, so a false value must omit it.
test('a false checkbox omits checked entirely', () => {
  assert.equal(
    renderToHtml(parseAzox('<input type="checkbox" bind:checked={no} />'), { no: sig(false) }),
    '<input type="checkbox">'
  );
});

test('a true checkbox renders the bare attribute', () => {
  assert.equal(
    renderToHtml(parseAzox('<input type="checkbox" bind:checked={yes} />'), { yes: sig(true) }),
    '<input type="checkbox" checked>'
  );
});

test('a bound value is escaped', () => {
  assert.equal(
    renderToHtml(parseAzox('<input bind:value={v} />'), { v: sig('"><script>') }),
    '<input value="&quot;&gt;&lt;script&gt;">'
  );
});

test('bind: never leaks into the markup as a literal attribute', () => {
  const html = renderToHtml(parseAzox('<input bind:value={name} />'), { name: sig('x') });
  assert.doesNotMatch(html, /bind:/);
});

/* ---------- fragments inside a keyed list ---------- */

// Regression, found in the published 1.0.0: a multi-root component
// returns a DocumentFragment, which empties when inserted and has no
// .remove(). A keyed row recorded the fragment itself, so removing the
// row threw "_node.remove is not a function" — the row stayed on screen
// and its onCleanup never ran.
test('a keyed row records its nodes, not the fragment holding them', () => {
  const code = compile(`<script>
  import { signal } from 'azox/reactivity';
  const xs = signal([]);
</script>
<dl><each item={xs()} as="x" key={x.id}><dt>{x.k}</dt><dd>{x.v}</dd></each></dl>`);

  assert.match(code, /instanceof DocumentFragment/, 'a fragment root must be expanded');
  assert.match(code, /childNodes/);
});

test('a single-element row still records the element itself', () => {
  const code = compile(`<script>
  import { signal } from 'azox/reactivity';
  const xs = signal([]);
</script>
<ul><each item={xs()} as="x" key={x.id}><li>{x.n}</li></each></ul>`);

  // The guard is cheap and uniform; what matters is that it is there.
  assert.match(code, /_nodes = \[_el\d+\]\.flatMap/);
});

/* ---------- SVG ---------- */

// Regression, seen on the site's own search button: createElement
// always makes an HTML element, so an inline <svg> was laid out as an
// unknown HTML tag — present in the DOM, 0×0 on screen, an empty box
// where the icon should be.
test('an svg element is created in the svg namespace', () => {
  const code = compile('<button><svg viewBox="0 0 24 24"></svg></button>');

  assert.match(code, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "svg"\)/);
  assert.match(code, /createElement\("button"\)/, 'the button stays HTML');
});

// <circle> and <path> carry no hint of their own, so the namespace has
// to be threaded down from the <svg> that opened it.
test('children of an svg inherit the namespace', () => {
  const code = compile('<svg><g><circle r="7" /><path d="M0 0" /></g></svg>');

  for (const tag of ['svg', 'g', 'circle', 'path']) {
    assert.match(
      code,
      new RegExp(`createElementNS\\("http://www\\.w3\\.org/2000/svg", "${tag}"\\)`),
      `${tag} must be in the svg namespace`
    );
  }
});

test('markup after an svg returns to HTML', () => {
  const code = compile('<div><svg><circle r="1" /></svg><span>after</span></div>');

  assert.match(code, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "circle"\)/);
  assert.match(code, /createElement\("span"\)/, 'a sibling of the svg is HTML again');
  assert.match(code, /createElement\("div"\)/);
});

test('viewBox keeps its casing, which SVG requires', () => {
  const code = compile('<svg viewBox="0 0 24 24"></svg>');
  assert.match(code, /"viewBox"/);
});

test('an svg renders on the server too', () => {
  assert.equal(
    renderToHtml(parseAzox('<svg viewBox="0 0 16 16"><circle r="7" /></svg>'), {}),
    '<svg viewBox="0 0 16 16"><circle r="7"></circle></svg>'
  );
});
