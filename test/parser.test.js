import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAzox } from '../core/compiler/parser.js';

test('separates the script block from the markup', () => {
  const { script, markup } = parseAzox(`<script>
  const x = 1;
</script>

<div>hello</div>`);

  assert.equal(script, 'const x = 1;');
  assert.equal(markup.type, 'element');
  assert.equal(markup.name, 'div');
});

test('parses a page with no script block', () => {
  const { script, markup } = parseAzox('<p>plain</p>');
  assert.equal(script, '');
  assert.equal(markup.name, 'p');
});

test('parses nested elements', () => {
  const { markup } = parseAzox('<main><h1>Title</h1><p>Body</p></main>');

  assert.equal(markup.name, 'main');
  assert.deepEqual(
    markup.children.map((c) => c.name),
    ['h1', 'p']
  );
});

test('parses static attributes', () => {
  const { markup } = parseAzox('<div class="page" id="root">x</div>');

  assert.deepEqual(markup.attrs.class, { kind: 'static', value: 'page' });
  assert.deepEqual(markup.attrs.id, { kind: 'static', value: 'root' });
});

test('parses expression attributes', () => {
  const { markup } = parseAzox('<div title={name()}>x</div>');
  assert.deepEqual(markup.attrs.title, { kind: 'expr', expr: 'name()' });
});

test('splits interpolation from surrounding text', () => {
  const { markup } = parseAzox('<p>Clicks: {count()}</p>');

  assert.deepEqual(markup.children[0].parts, [
    { kind: 'static', value: 'Clicks: ' },
    { kind: 'expr', expr: 'count()' },
  ]);
});

// Regression: the tokenizer used to stop at the first ">" in the tag,
// which cut an arrow function in an event handler in half.
test('an arrow function in an attribute does not truncate the tag', () => {
  const { markup } = parseAzox('<button on:click={() => count.set(count() + 1)}>Go</button>');

  assert.equal(markup.name, 'button');
  assert.deepEqual(markup.attrs['on:click'], {
    kind: 'expr',
    expr: '() => count.set(count() + 1)',
  });
  assert.deepEqual(markup.children[0].parts, [{ kind: 'static', value: 'Go' }]);
});

test('handles an attribute expression spanning multiple lines', () => {
  const { markup } = parseAzox(`<button on:click={() =>
    count.set(count() + 1)
  }>Go</button>`);

  assert.equal(markup.name, 'button');
  assert.match(markup.attrs['on:click'].expr, /count\.set/);
});

test('treats void elements as self-closing', () => {
  const { markup } = parseAzox('<div><br><img src="a.png"></div>');

  assert.deepEqual(
    markup.children.map((c) => c.name),
    ['br', 'img']
  );
  assert.deepEqual(markup.children[1].attrs.src, { kind: 'static', value: 'a.png' });
});

test('handles explicit self-closing syntax', () => {
  const { markup } = parseAzox('<div><span /></div>');
  assert.equal(markup.children[0].name, 'span');
  assert.deepEqual(markup.children[0].children, []);
});

// Regression: attribute values were matched with /\{[^}]*\}/, which
// stops at the first "}". An object literal in a handler was silently
// truncated, and the compiler emitted broken JavaScript while still
// reporting success.
test('an object literal in an attribute survives intact', () => {
  const { markup } = parseAzox(
    `<button on:click={() => user.set({ name: 'Changed' })}>Go</button>`
  );

  assert.equal(markup.attrs['on:click'].expr, "() => user.set({ name: 'Changed' })");
});

test('deeply nested braces in an attribute are kept', () => {
  const { markup } = parseAzox('<div data-x={ {a: {b: {c: 1}}} }>y</div>');
  assert.equal(markup.attrs['data-x'].expr, '{a: {b: {c: 1}}}');
});

test('a brace inside a string does not end the expression', () => {
  const { markup } = parseAzox(`<div title={"a } b"}>x</div>`);
  assert.equal(markup.attrs.title.expr, '"a } b"');
});

test('an escaped quote inside an expression string is handled', () => {
  const { markup } = parseAzox(`<div title={"he said \\"hi\\""}>x</div>`);
  assert.equal(markup.attrs.title.expr, '"he said \\"hi\\""');
});

test('a template literal with a placeholder is kept whole', () => {
  const { markup } = parseAzox('<div title={`n: ${count()}`}>x</div>');
  assert.equal(markup.attrs.title.expr, '`n: ${count()}`');
});

test('a ">" inside an attribute string does not end the tag', () => {
  const { markup } = parseAzox(`<div title={"a > b"}>text</div>`);

  assert.equal(markup.attrs.title.expr, '"a > b"');
  assert.deepEqual(markup.children[0].parts, [{ kind: 'static', value: 'text' }]);
});

test('an interpolated expression may contain nested braces', () => {
  const { markup } = parseAzox('<p>{ items.map(n => ({ v: n })).length }</p>');
  assert.deepEqual(markup.children[0].parts, [
    { kind: 'expr', expr: 'items.map(n => ({ v: n })).length' },
  ]);
});

test('an interpolated string may contain a brace', () => {
  const { markup } = parseAzox('<p>{"a } b"}</p>');
  assert.deepEqual(markup.children[0].parts, [{ kind: 'expr', expr: '"a } b"' }]);
});

test('attributes after a complex expression are still parsed', () => {
  const { markup } = parseAzox(
    `<button on:click={() => set({ a: 1 })} title="tip" class="btn">Go</button>`
  );

  assert.equal(markup.attrs.title.value, 'tip');
  assert.equal(markup.attrs.class.value, 'btn');
});

test('a value-less attribute is accepted', () => {
  const { markup } = parseAzox('<input disabled>');
  assert.deepEqual(markup.attrs.disabled, { kind: 'static', value: '' });
});

test('an unclosed attribute expression is reported', () => {
  assert.throws(
    () => parseAzox('<div title={ oops >x</div>'),
    /is never closed|unterminated/
  );
});

test('an unterminated quoted attribute is reported', () => {
  assert.throws(() => parseAzox('<div title="oops>x</div>'), /unterminated|never closed/);
});

// Regression: text was scanned to the next "<" without regard for
// expressions, so {a() < b()} — an ordinary comparison — was cut in
// half and reported as an unterminated tag.
test('a less-than inside an expression does not end the text', () => {
  const { markup } = parseAzox('<p>{a() < b()}</p>');
  assert.deepEqual(markup.children[0].parts, [{ kind: 'expr', expr: 'a() < b()' }]);
});

test('a less-than-or-equal is handled too', () => {
  const { markup } = parseAzox('<p>{a() <= b()}</p>');
  assert.deepEqual(markup.children[0].parts, [{ kind: 'expr', expr: 'a() <= b()' }]);
});

test('a template literal may contain markup', () => {
  const { markup } = parseAzox('<p>{`<b>x</b>`}</p>');
  assert.deepEqual(markup.children[0].parts, [{ kind: 'expr', expr: '`<b>x</b>`' }]);
});

test('a real tag after an expression is still found', () => {
  const { markup } = parseAzox('<p>{a() < b()}<em>after</em></p>');

  assert.equal(markup.children.length, 2);
  assert.equal(markup.children[1].name, 'em');
});

test('throws when an element is never closed', () => {
  assert.throws(() => parseAzox('<div>oops'), /<div> is never closed/);
});

test('throws when a tag is left unterminated', () => {
  assert.throws(() => parseAzox('<div class="x"'), /unterminated tag/);
});

test('reports a mismatched closing tag rather than silently accepting it', () => {
  assert.throws(() => parseAzox('<div><span>x</div>'), /never closed|parse error/i);
});
