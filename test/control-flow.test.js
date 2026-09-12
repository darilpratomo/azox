// <each> and <if>: parsing, server rendering, and the shape of the
// code the compiler emits for them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAzox } from '../core/compiler/parser.js';
import { compileToModule } from '../core/compiler/compileToJs.js';
import { resolveComponents } from '../core/compiler/resolveComponents.js';
import { createMemoryResolver } from '../core/compiler/sourceResolver.js';
import { renderToHtml } from '../core/renderer/renderToHtml.js';

const sig = (value) => {
  const read = () => value;
  read.set = (next) => {
    value = typeof next === 'function' ? next(value) : next;
  };
  read.peek = () => value;
  return read;
};

const render = (source, scope = {}) => renderToHtml(parseAzox(source), scope);
const compile = (source) =>
  compileToModule(parseAzox(source), { runtimeSpecifier: './runtime.js' });

/* ---------- parsing ---------- */

test('<each> parses into its own node type', () => {
  const { markup } = parseAzox('<ul><each item={list()} as="x"><li>{x}</li></each></ul>');
  const each = markup.children[0];

  assert.equal(each.type, 'each');
  assert.equal(each.expr, 'list()');
  assert.equal(each.alias, 'x');
  assert.equal(each.index, null);
});

test('<each> can declare an index', () => {
  const { markup } = parseAzox('<ul><each item={list()} as="x" index="i"><li>{i}</li></each></ul>');
  assert.equal(markup.children[0].index, 'i');
});

test('<if> splits its children at <else />', () => {
  const { markup } = parseAzox('<div><if cond={ok()}><p>a</p><else /><p>b</p></if></div>');
  const node = markup.children[0];

  assert.equal(node.type, 'if');
  assert.equal(node.expr, 'ok()');
  assert.equal(node.then.length, 1);
  assert.equal(node.otherwise.length, 1);
});

test('<if> without <else /> has an empty second branch', () => {
  const { markup } = parseAzox('<div><if cond={ok()}><p>a</p></if></div>');
  assert.deepEqual(markup.children[0].otherwise, []);
});

test('<each> without item= is rejected', () => {
  assert.throws(() => parseAzox('<ul><each as="x"><li>x</li></each></ul>'), /needs item=/);
});

test('<each> without as= is rejected', () => {
  assert.throws(() => parseAzox('<ul><each item={list()}><li>x</li></each></ul>'), /needs as=/);
});

test('<each> rejects an alias that is not an identifier', () => {
  assert.throws(
    () => parseAzox('<ul><each item={list()} as="not valid"><li>x</li></each></ul>'),
    /plain identifier/
  );
});

test('<if> without cond= is rejected', () => {
  assert.throws(() => parseAzox('<div><if><p>a</p></if></div>'), /needs cond=/);
});

/* ---------- server rendering ---------- */

test('a list renders on the server', () => {
  assert.equal(
    render('<ul><each item={items()} as="x"><li>{x}</li></each></ul>', { items: sig(['a', 'b']) }),
    '<ul><li>a</li><li>b</li></ul>'
  );
});

test('the index is available in the body', () => {
  assert.equal(
    render('<ul><each item={items()} as="x" index="i"><li>{i}:{x}</li></each></ul>', {
      items: sig(['a', 'b']),
    }),
    '<ul><li>0:a</li><li>1:b</li></ul>'
  );
});

test('an empty list renders nothing', () => {
  assert.equal(
    render('<ul><each item={items()} as="x"><li>{x}</li></each></ul>', { items: sig([]) }),
    '<ul></ul>'
  );
});

test('a null list renders nothing rather than throwing', () => {
  assert.equal(
    render('<ul><each item={items()} as="x"><li>{x}</li></each></ul>', { items: sig(null) }),
    '<ul></ul>'
  );
});

test('a true condition renders the first branch', () => {
  assert.equal(
    render('<div><if cond={ok()}><p>yes</p><else /><p>no</p></if></div>', { ok: sig(true) }),
    '<div><p>yes</p></div>'
  );
});

test('a false condition renders the second branch', () => {
  assert.equal(
    render('<div><if cond={ok()}><p>yes</p><else /><p>no</p></if></div>', { ok: sig(false) }),
    '<div><p>no</p></div>'
  );
});

test('a false condition with no else renders nothing', () => {
  assert.equal(
    render('<div><if cond={ok()}><p>yes</p></if></div>', { ok: sig(false) }),
    '<div></div>'
  );
});

test('<if> nested inside <each> sees the loop variable', () => {
  assert.equal(
    render('<div><each item={rows()} as="row"><if cond={row.on}><b>{row.name}</b></if></each></div>', {
      rows: sig([
        { name: 'A', on: true },
        { name: 'B', on: false },
      ]),
    }),
    '<div><b>A</b></div>'
  );
});

test('loops nest', () => {
  assert.equal(
    render(
      '<div><each item={outer()} as="o"><each item={o.items} as="i"><b>{i}</b></each></each></div>',
      { outer: sig([{ items: ['a', 'b'] }, { items: ['c'] }]) }
    ),
    '<div><b>a</b><b>b</b><b>c</b></div>'
  );
});

test('values inside a loop are escaped', () => {
  assert.equal(
    render('<ul><each item={items()} as="x"><li>{x}</li></each></ul>', {
      items: sig(['<script>bad()</script>']),
    }),
    '<ul><li>&lt;script&gt;bad()&lt;/script&gt;</li></ul>'
  );
});

test('a second <else /> is rejected rather than leaking as a tag', () => {
  assert.throws(
    () => parseAzox('<div><if cond={c}><p>a</p><else /><p>b</p><else /><p>c</p></if></div>'),
    /only one <else \/>/
  );
});

test('<each> over something that is not iterable is reported clearly', () => {
  assert.throws(
    () => render('<ul><each item={n()} as="x"><li>{x}</li></each></ul>', { n: sig(5) }),
    /needs something iterable/
  );
});

test('<each> over a string iterates its characters', () => {
  assert.equal(
    render('<ul><each item={s()} as="c"><li>{c}</li></each></ul>', { s: sig('ab') }),
    '<ul><li>a</li><li>b</li></ul>'
  );
});

/* ---------- with components ---------- */

// Regression: expand() only walked node.children, but <if> keeps its
// children in two branches — so a component inside a conditional was
// never resolved and reached the output as a raw <Tag>.
test('a component inside <if> is resolved', () => {
  const ast = resolveComponents(
    parseAzox(`<script>
  import C from './C.azox';
</script>
<div><if cond={ok()}><C label="shown" /></if></div>`),
    '/index.azox',
    createMemoryResolver({
      '/C.azox': `<script>
  const { label } = props();
</script>
<b>{label}</b>`,
    })
  );

  assert.equal(renderToHtml(ast, { ok: sig(true) }), '<div><b>shown</b></div>');
});

// Regression: substituteProps skipped control-flow nodes, so a
// component looping over one of its own props compiled to an
// expression naming something that did not exist.
test('a component can loop over one of its props', () => {
  const ast = resolveComponents(
    parseAzox(`<script>
  import L from './L.azox';
</script>
<div><L items={rows()} /></div>`),
    '/index.azox',
    createMemoryResolver({
      '/L.azox': `<script>
  const { items } = props();
</script>
<ul><each item={items} as="x"><li>{x}</li></each></ul>`,
    })
  );

  assert.equal(
    renderToHtml(ast, { rows: sig(['a', 'b']) }),
    '<div><ul><li>a</li><li>b</li></ul></div>'
  );
});

test('a component can branch on one of its props', () => {
  const ast = resolveComponents(
    parseAzox(`<script>
  import B from './B.azox';
</script>
<div><B on={flag()} /></div>`),
    '/index.azox',
    createMemoryResolver({
      '/B.azox': `<script>
  const { on } = props();
</script>
<p><if cond={on}>yes<else />no</if></p>`,
    })
  );

  assert.equal(renderToHtml(ast, { flag: sig(false) }), '<div><p>no</p></div>');
});

// A loop variable shadows a prop of the same name inside the body,
// while the list expression itself still sees the prop.
test('a loop variable shadows a prop of the same name', () => {
  const ast = resolveComponents(
    parseAzox(`<script>
  import L from './L.azox';
</script>
<L rows={data()} />`),
    '/index.azox',
    createMemoryResolver({
      '/L.azox': `<script>
  const { rows } = props();
</script>
<ul><each item={rows} as="rows"><li>{rows}</li></each></ul>`,
    })
  );

  assert.equal(renderToHtml(ast, { data: sig(['p', 'q']) }), '<ul><li>p</li><li>q</li></ul>');
});

test('an unimported component inside control flow is still caught', () => {
  assert.throws(
    () =>
      resolveComponents(
        parseAzox('<div><if cond={x}><Missing /></if></div>'),
        '/i.azox',
        createMemoryResolver({})
      ),
    /never imported/
  );
});

/* ---------- compiled output ---------- */

test('a control block is anchored by comment nodes', () => {
  const code = compile('<ul><each item={items()} as="x"><li>{x}</li></each></ul>');
  assert.match(code, /createComment\(''\)/);
});

test('the loop body is compiled once, not per item', () => {
  const code = compile('<ul><each item={items()} as="x"><li>{x}</li></each></ul>');

  // One createElement("li") in a builder function, not one per item.
  assert.equal((code.match(/createElement\("li"\)/g) ?? []).length, 1);
  assert.match(code, /\(x\) => \{/, 'the body takes the alias as a parameter');
});

// Regression: the block used to check for a parent before reading its
// source. An effect subscribes only to what it reads, so on the first
// run — before anything was mounted — it returned early, subscribed to
// nothing, and never updated again.
test('the source is read before any early return', () => {
  const code = compile('<ul><each item={items()} as="x"><li>{x}</li></each></ul>');

  const readAt = code.indexOf('const _source =');
  const returnAt = code.indexOf('if (!_parent) return;');

  assert.ok(readAt !== -1 && readAt < returnAt, 'reading first is what keeps it subscribed');
});

// Regression: the markers were appended to their fragment after the
// block's effect had already run, so it found no parent. A nested
// block made this permanent — its markers are rebuilt on every outer
// update, so any one-time "start later" step is long past.
test('markers are put in a fragment before the effect runs', () => {
  const code = compile('<ul><each item={items()} as="x"><li>{x}</li></each></ul>');

  const appendAt = code.indexOf('.append(');
  const effectAt = code.indexOf('const _source =');

  assert.ok(appendAt !== -1 && appendAt < effectAt, 'markers need a parent before the effect runs');
});

test('a nested block is self-contained, not deferred to mount', () => {
  const code = compile(
    '<div><each item={rows()} as="r"><each item={r.tags} as="t"><b>{t}</b></each></each></div>'
  );

  assert.doesNotMatch(code, /_blocks/, 'a block must not depend on a one-time mount step');
  assert.equal((code.match(/document\.createComment/g) ?? []).length, 4, 'two blocks, two markers each');
});

test('a page with a loop is treated as reactive, not static', () => {
  const code = compile('<ul><each item={items()} as="x"><li>{x}</li></each></ul>');
  assert.match(code, /innerHTML = ''/, 'a page with control flow must hydrate');
});

test('both branches of an <if> compile into one builder', () => {
  const code = compile('<div><if cond={ok()}><p>a</p><else /><b>c</b></if></div>');

  assert.match(code, /createElement\("p"\)/);
  assert.match(code, /createElement\("b"\)/);
  assert.match(code, /\(_branch\) => \{/);
});
