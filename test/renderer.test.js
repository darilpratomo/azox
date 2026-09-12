import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAzox } from '../core/compiler/parser.js';
import { renderToHtml } from '../core/renderer/renderToHtml.js';
import { declaredNames } from '../core/renderer/serverScope.js';

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

// Regression: the tokenizer trimmed text outright, so the space in
// "Read <a>this</a> for more" vanished and the words ran together.
test('a space before an inline tag survives', () => {
  assert.equal(
    render('<p>Read <a href="/why">why</a> for the reasoning.</p>'),
    '<p>Read <a href="/why">why</a> for the reasoning.</p>'
  );
});

test('a space after an inline tag survives', () => {
  assert.equal(render('<p>a <b>b</b> c</p>'), '<p>a <b>b</b> c</p>');
});

test('text with no space around a tag stays joined', () => {
  assert.equal(render('<p>No<em>space</em>here</p>'), '<p>No<em>space</em>here</p>');
});

test('indentation between elements is dropped', () => {
  assert.equal(
    render('<div>\n  <span>a</span>\n  <span>b</span>\n</div>'),
    '<div><span>a</span><span>b</span></div>'
  );
});

test('whitespace just inside an element is dropped', () => {
  assert.equal(render('<button>\n  Clicks: 0\n</button>'), '<button>Clicks: 0</button>');
});

test('runs of whitespace collapse to one space', () => {
  assert.equal(render('<p>one     two</p>'), '<p>one two</p>');
});

// Regression: a comment was parsed as a tag, so writing one produced
// a confusing error about an element nobody had written.
test('an HTML comment is dropped from the output', () => {
  assert.equal(render('<div><!-- note --><p>x</p></div>'), '<div><p>x</p></div>');
});

test('a comment containing tags is still just a comment', () => {
  assert.equal(render('<div><!-- <b>not real</b> --><p>x</p></div>'), '<div><p>x</p></div>');
});

test('a comment may span lines', () => {
  assert.equal(render('<div><!--\n  over\n  lines\n--><p>x</p></div>'), '<div><p>x</p></div>');
});

test('an unclosed comment is reported', () => {
  assert.throws(() => parseAzox('<div><!-- oops</div>'), /comment is never closed/);
});

test('a <text> block renders its content literally', () => {
  const html = render('<pre><text><button on:click={go}>Hi</button></text></pre>');
  assert.equal(html, '<pre>&lt;button on:click={go}&gt;Hi&lt;/button&gt;</pre>');
});

test('a <text> block does not interpolate braces', () => {
  const html = render('<p><text>{count()}</text></p>', { count: () => 99 });
  assert.equal(html, '<p>{count()}</p>', 'the expression must not be evaluated');
});

test('an entity written in static markup is not double-escaped', () => {
  assert.equal(render('<p>&lt;tag&gt;</p>'), '<p>&lt;tag&gt;</p>');
});

test('an unclosed <text> block is reported', () => {
  assert.throws(() => parseAzox('<p><text>oops</p>'), /<text> is never closed/);
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

// Escaping, stated as what a browser would do with the output rather
// than as a string comparison. Verified in headless Chrome: none of
// these payloads creates an attribute or an element.
test('a quote in an attribute value cannot close the attribute', () => {
  const html = renderToHtml(parseAzox('<p title={v}>x</p>'), { v: '" onload="bad()' });

  assert.match(html, /title="&quot; onload=&quot;bad\(\)"/);
  // With quotes encoded, no second attribute can appear.
  assert.doesNotMatch(html.replace(/&quot;/g, 'Q'), /="[^"]*"\s+\w+="/);
});

test('a closing tag in text stays text', () => {
  const html = renderToHtml(parseAzox('<p>{v}</p>'), {
    v: '</p><img src=x onerror="bad()">',
  });

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('a payload in href cannot add an event handler', () => {
  const html = renderToHtml(parseAzox('<a href={v}>x</a>'), { v: '" onmouseover="bad()' });

  // The whole payload stays inside the one quoted value: every quote is
  // encoded, so the attribute never closes and no second one begins.
  assert.equal(html, '<a href="&quot; onmouseover=&quot;bad()">x</a>');
  assert.equal(html.match(/"/g).length, 2, 'only the attribute\'s own quotes are literal');
});

test('an ampersand in text is encoded once, not twice', () => {
  assert.equal(renderToHtml(parseAzox('<p>{v}</p>'), { v: 'a & b' }), '<p>a &amp; b</p>');
});

/* ---------- what a script declares ---------- */

// Regression: declaredNames matched any `const` anywhere in the script,
// so a variable inside a callback was returned from the outer scope —
// "timer is not defined", which took down any page holding an interval
// in onMount. That is the ordinary way to write a timer.
test('a name declared inside a callback is not treated as a declaration', () => {
  const names = declaredNames(`const visitors = signal(1);
onMount(() => {
  const timer = setInterval(() => {}, 900);
  return () => clearInterval(timer);
});`);

  assert.deepEqual(names, ['visitors']);
});

test('top-level declarations of every kind are collected', () => {
  const names = declaredNames(`const a = 1;
let b = 2;
var c = 3;
function f() {}
class C {}`);

  assert.deepEqual(names.sort(), ['C', 'a', 'b', 'c', 'f']);
});

test('a destructured declaration is collected, aliases included', () => {
  assert.deepEqual(declaredNames('const { x, y: z } = props();').sort(), ['x', 'z']);
});

test('a destructured declaration inside a callback is not', () => {
  const names = declaredNames(`const top = 1;
onMount(() => {
  const { inner } = thing;
});`);

  assert.deepEqual(names, ['top']);
});

test('a brace inside a string does not confuse the depth count', () => {
  assert.deepEqual(declaredNames('const msg = "a { b";\nconst ok = 1;').sort(), ['msg', 'ok']);
});

test('an object literal value does not hide what follows it', () => {
  assert.deepEqual(declaredNames('const cfg = { deep: 1 };\nconst after = 2;').sort(), [
    'after',
    'cfg',
  ]);
});

test('a function declared at the top level is collected', () => {
  assert.deepEqual(declaredNames('const a = 1;\nfunction go() { const inner = 2; }').sort(), [
    'a',
    'go',
  ]);
});
