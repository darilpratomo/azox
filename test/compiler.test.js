import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAzox } from '../core/compiler/parser.js';
import { compileToModule } from '../core/compiler/compileToJs.js';

const compile = (source, options = {}) =>
  compileToModule(parseAzox(source), {
    runtimeSpecifier: './azox-runtime.js',
    ...options,
  });

test('imports the runtime from the given specifier', () => {
  const code = compile('<div>x</div>');
  assert.match(code, /import \{ effect \} from '\.\/azox-runtime\.js'/);
});

test('emits createElement for each element', () => {
  const code = compile('<main><h1>Title</h1></main>');
  assert.match(code, /document\.createElement\("main"\)/);
  assert.match(code, /document\.createElement\("h1"\)/);
});

test('static text becomes a plain text node with no effect', () => {
  const code = compile('<p>Hello</p>');
  assert.match(code, /createTextNode\("Hello"\)/);
  assert.doesNotMatch(code, /effect\(/, 'static content needs no reactive wrapper');
});

test('interpolated text is wrapped in an effect', () => {
  const code = compile('<p>Clicks: {count()}</p>');
  assert.match(code, /effect\(\(\) => \{ _el\d+\.data = "Clicks: " \+ String\(count\(\)\); \}\)/);
});

test('static attributes are set directly', () => {
  const code = compile('<div class="page">x</div>');
  assert.match(code, /setAttribute\("class", "page"\)/);
});

test('dynamic attributes are wrapped in their own effect', () => {
  const code = compile('<div title={label()}>x</div>');
  assert.match(code, /effect\(\(\) => \{ _el\d+\.setAttribute\("title", String\(label\(\)\)\); \}\)/);
});

test('on: attributes become event listeners, not attributes', () => {
  const code = compile('<button on:click={handler}>Go</button>');
  assert.match(code, /addEventListener\("click", handler\)/);
  assert.doesNotMatch(code, /setAttribute\("on:click"/);
});

// Path rewriting belongs to the build, which knows where files land;
// the compiler only offers the hook. The real rebasing is covered in
// build-api.test.js.
// createTextNode takes text, not markup. If an entity reached it
// undecoded, the browser would show "&lt;" where the server rendered
// "<" — the page would visibly change the moment it hydrated.
test('entities in static text are decoded for createTextNode', () => {
  const code = compile('<p>&lt;tag&gt;</p>');
  assert.match(code, /createTextNode\("<tag>"\)/);
});

test('a <text> block reaches createTextNode verbatim', () => {
  const code = compile('<pre><text><button>{x}</button></text></pre>');
  assert.match(code, /createTextNode\("<button>\{x\}<\/button>"\)/);
});

test('a <text> block creates no effect, since it is not dynamic', () => {
  const code = compile('<pre><text>{count()}</text></pre>');
  assert.doesNotMatch(code, /effect\(/);
});

test('applies the rewriteImports hook to the user script', () => {
  const code = compile(
    `<script>
  import { helper } from '../lib/helper.js';
</script>
<div>x</div>`,
    { rewriteImports: (script) => script.replace('../lib/helper.js', './REWRITTEN.js') }
  );

  assert.match(code, /from '\.\/REWRITTEN\.js'/);
});

test('leaves the script alone when no rewriteImports hook is given', () => {
  const code = compile(`<script>
  import { helper } from '../lib/helper.js';
</script>
<div>x</div>`);

  assert.match(code, /from '\.\.\/lib\/helper\.js'/);
});

test('leaves bare specifiers untouched for the resolver', () => {
  const code = compile(`<script>
  import { signal } from 'azox/reactivity';
</script>
<div>x</div>`);

  assert.match(code, /from 'azox\/reactivity'/);
});

test('a page with bindings hydrates into the SSR root', () => {
  const code = compile('<div>{count()}</div>');
  assert.match(code, /querySelector\('\[data-azox-root\]'\)/);
});

test('a page with a listener hydrates too', () => {
  const code = compile('<button on:click={go}>x</button>');
  assert.match(code, /querySelector\('\[data-azox-root\]'\)/);
});

// A fully static page is already finished when it arrives. Rebuilding
// it would waste work and, worse, detach nodes that other scripts on
// the page may be holding a reference to.
test('a static page does not touch the DOM on load', () => {
  const code = compile('<div>just text</div>');

  assert.doesNotMatch(code, /innerHTML = ''/);
  assert.doesNotMatch(code, /querySelector\('\[data-azox-root\]'\)/);
  assert.match(code, /export function render/, 'render is still exported');
});

test('element ids restart on each compile so output is deterministic', () => {
  const source = '<main><h1>A</h1></main>';
  assert.equal(compile(source), compile(source));
});
