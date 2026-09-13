import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAzox } from '../core/compiler/parser.js';
import { compileToModule } from '../core/compiler/compileToJs.js';
import { adopt } from '../core/reactivity/signal.js';

// Hydration used to run `mount.innerHTML = ''` and rebuild the page,
// which destroyed focus, a caret position and an open <details>. The
// walker adopts the nodes the server already sent instead.
//
// Adoption is gated, and the gate is the thing worth testing: a page
// that adopts half its tree and rebuilds the rest would bind effects
// across two generations of nodes. See docs/hydration.md.

const compiled = (markup, script = "import { signal } from 'azox/reactivity';\n  const n = signal(0);") =>
  compileToModule(parseAzox(`<script>\n  ${script}\n</script>\n${markup}`), {
    runtimeSpecifier: './azox-runtime.js',
  });

test('a hydrating page with no control flow adopts the server nodes', () => {
  const code = compiled('<main><input id="field" /><button on:click={() => n.set(1)}>go {n()}</button></main>');

  assert.match(code, /import \{[^}]*\badopt\b[^}]*\} from '[^']+'/, 'imports the walker');
  assert.match(code, /export function render\(mount, _cursor = null\)/, 'takes a cursor');
  assert.match(code, /_cursor\?\.next\("main"\)/, 'and walks from the root');
  assert.match(code, /const _cursor = adopt\(mount\);/, 'which hydration opens');
  assert.doesNotMatch(code, /mount\.innerHTML = ''/, 'instead of clearing the markup');
});

// A cursor is optional because render() is exported: the router and
// anyone mounting by hand call it with a mount and nothing else. Without
// the guard that call throws on null instead of creating the node.
test('an adopted node falls back to creation when no cursor is passed', () => {
  const code = compiled('<main><input id="field" /><button on:click={() => n.set(1)}>go {n()}</button></main>');

  // Every walk is an optional call, so a missing cursor yields undefined
  // rather than throwing.
  for (const line of code.split('\n').filter((l) => l.includes('.next('))) {
    assert.match(line, /\?\.next\(/, `optional call required: ${line.trim()}`);
  }

  // And every node the walker might have returned has a creation
  // fallback, so an absent cursor still builds the node.
  const taken = [...code.matchAll(/const (_el\d+) = _cursor\?\.next\(|const (_el\d+) = _el\d+\?\.next\(/g)]
    .map((m) => m[1] ?? m[2]);
  assert.ok(taken.length, 'the page adopts something');
  for (const name of taken) {
    assert.match(
      code,
      new RegExp(`const _el\\d+ = ${name} \\?\\? document\\.create`),
      `${name} needs a creation fallback`
    );
  }
});

// An adopted node is already in position. Appending it would detach and
// re-attach it, which blurs it — the bug that cost the reader's focus
// even after the nodes themselves were preserved.
test('an adopted node is never appended', () => {
  const code = compiled('<main><input id="field" /><button on:click={() => n.set(1)}>go {n()}</button></main>');

  const takenFor = new Map();
  for (const m of code.matchAll(/const (_el\d+) = (_el\d+|_cursor)\?\.next\([^)]*\);\n\s*const (_el\d+) = \1 \?\?/g)) {
    takenFor.set(m[3], m[1]);
  }
  assert.ok(takenFor.size, 'the page adopts something');

  for (const [node, taken] of takenFor) {
    const bare = new RegExp(`^\\s*(?:mount|_el\\d+)\\.appendChild\\(${node}\\);`, 'm');
    assert.doesNotMatch(code, bare, `${node} is adopted and must not be appended outright`);
    assert.match(
      code,
      new RegExp(`if \\(!${taken}\\) (?:mount|_el\\d+)\\.appendChild\\(${node}\\);`),
      `${node} must be appended only when it was created`
    );
  }
});

// A control-flow block anchors on two comment nodes, and adopting the
// region between them means adopting the pair itself. The cursor could
// not name a comment until now: `expect` was a tag or null for text, and
// a comment is neither.
test('the cursor can adopt a control-flow marker', () => {
  const node = (nodeName, nodeType) => ({
    nodeName,
    nodeType,
    childNodes: [],
    parentNode: null,
    get firstChild() {
      return this.childNodes[0] ?? null;
    },
    get nextSibling() {
      if (!this.parentNode) return null;
      const siblings = this.parentNode.childNodes;
      return siblings[siblings.indexOf(this) + 1] ?? null;
    },
    appendChild(child) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      const siblings = this.parentNode.childNodes;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentNode = null;
    },
  });

  const parent = node('DIV', 1);
  const open = node('#comment', 8);
  const row = node('LI', 1);
  const text = node('#text', 3);
  const close = node('#comment', 8);
  for (const child of [open, row, text, close]) parent.appendChild(child);

  const cursor = adopt(parent);
  assert.equal(cursor.next('#comment'), open, 'the start marker');
  assert.equal(cursor.next('li'), row, 'then what is between it');
  assert.equal(cursor.next(null), text);
  assert.equal(cursor.next('#comment'), close, 'and the end marker');

  // A marker must not satisfy a request for an element or for text, or a
  // block's anchors would be adopted as its content.
  const lone = node('DIV', 1);
  lone.appendChild(node('#comment', 8));
  assert.equal(adopt(lone).next('li'), null, 'not an element');
  assert.equal(adopt(lone).next(null), null, 'not text');
});

// An <if> or <each> rebuilds its rows on every run. Adopting the markup
// around one would leave the page part server, part client.
test('a page with control flow keeps the wholesale rebuild', () => {
  const code = compiled(
    '<main><ul><each item={items()} as="x"><li>{x}</li></each></ul></main>',
    "import { signal } from 'azox/reactivity';\n  const items = signal(['a']);"
  );

  assert.match(code, /mount\.innerHTML = ''/, 'still clears');
  assert.doesNotMatch(code, /\badopt\(/, 'and never opens a cursor');
  assert.match(code, /export function render\(mount\)/, 'signature unchanged');
});

// A static page ships no hydration block at all, so no cursor can reach
// its render(): importing the walker there is dead weight.
test('a static page does not import the walker', () => {
  const code = compiled('<main><h1>Halo</h1></main>', '');

  assert.doesNotMatch(code, /\badopt\b/, 'no walker');
  assert.match(code, /azox:static/, 'and still marked static');
});

// A void element has nothing to walk, so opening a cursor for it and
// closing it again emits three lines that can never match anything.
test('a childless element opens no cursor', () => {
  const code = compiled('<main><input id="field" /><button on:click={() => n.set(1)}>go {n()}</button></main>');

  const input = code.match(/const (_el\d+) = _el\d+\?\.next\("input"\)/);
  assert.ok(input, 'the input is adopted');
  assert.doesNotMatch(code, new RegExp(`adopt\\(${input[1]}\\)`), 'but walks no children');
});
