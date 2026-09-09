// <each> and <if>: parsing, server rendering, and the shape of the
// code the compiler emits for them.

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

test('the source is read before any early return', () => {
  const code = compile('<ul><each item={items()} as="x"><li>{x}</li></each></ul>');

  const effectBody = code.slice(code.indexOf('_blocks.push'));
  const readAt = effectBody.indexOf('const _source =');
  const returnAt = effectBody.indexOf('if (!_parent) return;');

  assert.ok(readAt !== -1 && readAt < returnAt, 'reading first is what keeps it subscribed');
});

// Regression: blocks used to start during render, when their markers
// had no parent yet, so they bailed out before subscribing and never
// rendered anything at all.
test('blocks start after the tree is mounted', () => {
  const code = compile('<ul><each item={items()} as="x"><li>{x}</li></each></ul>');

  const mountAt = code.indexOf('mount.appendChild');
  const startAt = code.indexOf('for (const _start of _blocks)');

  assert.ok(startAt > mountAt, 'blocks must start after the tree is in the document');
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
