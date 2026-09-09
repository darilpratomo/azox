import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAzox } from '../core/compiler/parser.js';
import { renderToHtml } from '../core/renderer/renderToHtml.js';

const render = (source, scope = {}) => renderToHtml(parseAzox(source), scope);

test('renders nested static markup', () => {
  assert.equal(
    render('<main><h1>Title</h1><p>Body</p></main>'),
    '<main><h1>Title</h1><p>Body</p></main>'
  );
});

test('renders static attributes', () => {
  assert.equal(render('<div class="page">x</div>'), '<div class="page">x</div>');
});

test('evaluates interpolated expressions against the scope', () => {
  assert.equal(render('<p>Clicks: {count()}</p>', { count: () => 7 }), '<p>Clicks: 7</p>');
});

test('evaluates dynamic attributes', () => {
  assert.equal(
    render('<div title={label()}>x</div>', { label: () => 'hi' }),
    '<div title="hi">x</div>'
  );
});

test('omits event handlers from server output', () => {
  const html = render('<button on:click={handler}>Go</button>', { handler: () => {} });
  assert.equal(html, '<button>Go</button>');
});

test('renders void elements without a closing tag', () => {
  assert.equal(render('<div><br></div>'), '<div><br></div>');
});

test('escapes HTML in interpolated values', () => {
  const html = render('<p>{value()}</p>', { value: () => '<script>alert(1)</script>' });
  assert.equal(html, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('escapes quotes in dynamic attribute values', () => {
  const html = render('<div title={value()}>x</div>', { value: () => 'a"b' });
  assert.equal(html, '<div title="a&quot;b">x</div>');
});

test('escapes ampersands so entities are not double-decoded', () => {
  assert.equal(render('<p>{value()}</p>', { value: () => 'a & b' }), '<p>a &amp; b</p>');
});
