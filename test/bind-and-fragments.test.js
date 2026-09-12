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
