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

test('throws when an element is never closed', () => {
  assert.throws(() => parseAzox('<div>oops'), /<div> is never closed/);
});

test('throws when a tag is left unterminated', () => {
  assert.throws(() => parseAzox('<div class="x"'), /unterminated tag/);
});

test('reports a mismatched closing tag rather than silently accepting it', () => {
  assert.throws(() => parseAzox('<div><span>x</div>'), /never closed|parse error/i);
});
