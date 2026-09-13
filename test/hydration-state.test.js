import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAzox } from '../core/compiler/parser.js';
import { compileToModule } from '../core/compiler/compileToJs.js';
import { renderToHtml } from '../core/renderer/renderToHtml.js';

const sig = (value) => {
  const read = () => value;
  read.set = () => {};
  read.peek = () => value;
  return read;
};

// Hydration replaces the server's markup wholesale, which destroys the
// reader's focus, caret and any expanded <details>. Closing that gap
// needs the server and the client to agree on where a control-flow
// region begins and ends — today they do not, and these pin the exact
// mismatch so the fix is provable rather than asserted.
//
// See docs/hydration.md.

test('the client anchors control flow on comment markers', () => {
  const code = compileToModule(parseAzox('<ul><each item={xs()} as="x"><li>{x}</li></each></ul>'), {
    runtimeSpecifier: './runtime.js',
  });

  assert.equal(code.match(/createComment/g)?.length, 2, 'one pair per block');
  assert.match(code, /insertBefore\(/, 'and updates work against them');
});

test('an if block anchors on its own pair', () => {
  const code = compileToModule(parseAzox('<div><if cond={ok()}><p>a</p></if></div>'), {
    runtimeSpecifier: './runtime.js',
  });

  assert.equal(code.match(/createComment/g)?.length, 2);
});

// The gap, now closed: the server emits the same pair the client
// builds, so an adopting walker has something to align on.
test('the server emits the markers the client expects', () => {
  const html = renderToHtml(parseAzox('<ul><each item={xs()} as="x"><li>{x}</li></each></ul>'), {
    xs: sig(['a', 'b']),
  });

  assert.equal(html, '<ul><!--[--><li>a</li><li>b</li><!--]--></ul>');
});

test('an empty block still gets its anchors', () => {
  // Without them the block has nowhere to render into when it fills.
  assert.equal(
    renderToHtml(parseAzox('<ul><each item={xs()} as="x"><li>{x}</li></each></ul>'), { xs: sig([]) }),
    '<ul><!--[--><!--]--></ul>'
  );
});

test('server and client agree on the marker text', () => {
  const html = renderToHtml(parseAzox('<div><if cond={ok()}><p>a</p></if></div>'), { ok: sig(true) });
  const code = compileToModule(parseAzox('<div><if cond={ok()}><p>a</p></if></div>'), {
    runtimeSpecifier: './runtime.js',
  });

  const serverOpen = html.includes('<!--[-->');
  const clientOpen = /createComment\('\['\)/.test(code);

  assert.ok(serverOpen && clientOpen, 'both sides use the same start marker');
  assert.ok(html.includes('<!--]-->') && /createComment\('\]'\)/.test(code), 'and the same end');
});

test('nested blocks each need their own pair', () => {
  const code = compileToModule(
    parseAzox('<div><each item={xs()} as="x"><if cond={x.on}><b>{x.n}</b></if></each></div>'),
    { runtimeSpecifier: './runtime.js' }
  );

  assert.equal(code.match(/createComment/g)?.length, 4, 'two blocks, two pairs');
});
