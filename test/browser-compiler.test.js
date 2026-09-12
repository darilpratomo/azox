// The compiler must stay runnable in a browser: that is what makes
// the playground possible. These tests compile from an in-memory map
// with no filesystem involved, and guard against a Node built-in
// creeping back into the compiler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAzox } from '../core/compiler/parser.js';
import { resolveComponents, ComponentError } from '../core/compiler/resolveComponents.js';
import { compileToModule } from '../core/compiler/compileToJs.js';
import { renderToHtml } from '../core/renderer/renderToHtml.js';
import { createMemoryResolver, joinPath } from '../core/compiler/sourceResolver.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A stand-in for the real runtime, enough for server rendering.
const signalStub = (value) => {
  const read = () => value;
  read.set = (next) => {
    value = typeof next === 'function' ? next(value) : next;
  };
  read.peek = () => value;
  return read;
};

const compileFromMemory = (pageSource, files = {}, pageId = '/index.azox') => {
  const resolver = createMemoryResolver(files);
  return resolveComponents(parseAzox(pageSource), pageId, resolver);
};

test('joinPath resolves a sibling', () => {
  assert.equal(joinPath('/pages/index.azox', './Card.azox'), '/pages/Card.azox');
});

test('joinPath climbs out of a directory', () => {
  assert.equal(joinPath('/pages/index.azox', '../components/Card.azox'), '/components/Card.azox');
});

test('joinPath handles several levels', () => {
  assert.equal(joinPath('/a/b/c/page.azox', '../../x/y.azox'), '/a/x/y.azox');
});

test('a memory resolver reads a file it holds', () => {
  const resolver = createMemoryResolver({ '/Card.azox': '<p>card</p>' });
  assert.equal(resolver.read('/Card.azox'), '<p>card</p>');
});

test('a memory resolver returns null for a file it does not hold', () => {
  const resolver = createMemoryResolver({});
  assert.equal(resolver.read('/Missing.azox'), null);
});

test('a memory resolver accepts paths written without a leading slash', () => {
  const resolver = createMemoryResolver({ 'Card.azox': '<p>card</p>' });
  assert.equal(resolver.read('/Card.azox'), '<p>card</p>');
});

test('a page with a component compiles entirely from memory', () => {
  const ast = compileFromMemory(
    `<script>
  import Card from './Card.azox';
</script>
<main><Card title="Hi" /></main>`,
    {
      '/Card.azox': `<script>
  const { title } = props();
</script>
<article>{title}</article>`,
    }
  );

  assert.equal(renderToHtml(ast, {}), '<main><article>Hi</article></main>');
});

test('reactivity survives compilation from memory', () => {
  const ast = compileFromMemory(
    `<script>
  import Card from './Card.azox';
</script>
<main><Card value={count()} /></main>`,
    {
      '/Card.azox': `<script>
  const { value } = props();
</script>
<span>{value}</span>`,
    }
  );

  const js = compileToModule(ast, { runtimeSpecifier: './runtime.js' });

  assert.match(js, /effect\(\(\) => \{ _el\d+\.data = String\(\(count\(\)\)\); \}\)/);
  assert.equal(renderToHtml(ast, { count: signalStub(7) }), '<main><span>7</span></main>');
});

test('nested components resolve through the memory resolver', () => {
  const ast = compileFromMemory(
    `<script>
  import Outer from './components/Outer.azox';
</script>
<main><Outer /></main>`,
    {
      '/components/Outer.azox': `<script>
  import Inner from './Inner.azox';
</script>
<div><Inner /></div>`,
      '/components/Inner.azox': '<em>deep</em>',
    }
  );

  assert.equal(renderToHtml(ast, {}), '<main><div><em>deep</em></div></main>');
});

test('a missing component is reported the same way as on disk', () => {
  assert.throws(
    () =>
      compileFromMemory(
        `<script>
  import Ghost from './Ghost.azox';
</script>
<main><Ghost /></main>`,
        {}
      ),
    ComponentError
  );
});

test('a component cycle is caught in memory too', () => {
  assert.throws(
    () =>
      compileFromMemory(
        `<script>
  import Loop from './Loop.azox';
</script>
<main><Loop /></main>`,
        {
          '/Loop.azox': `<script>
  import Loop from './Loop.azox';
</script>
<div><Loop /></div>`,
        }
      ),
    /cycle detected/
  );
});

test('compileToModule needs no path options', () => {
  const ast = parseAzox('<p>{value()}</p>');
  const js = compileToModule(ast, { runtimeSpecifier: 'https://cdn.example/runtime.js' });

  assert.match(js, /from 'https:\/\/cdn\.example\/runtime\.js'/);
});

// The guard: if a Node built-in reappears in these directories, the
// playground breaks in a way that is easy to miss until it ships.
test('the compiler, renderer and runtime import no Node built-ins', () => {
  const offenders = [];

  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;

      const source = readFileSync(full, 'utf8');
      // Import statements only — a mention in a comment is fine.
      if (/^\s*import\s[^;]*['"]node:/m.test(source)) {
        offenders.push(full.slice(ROOT.length + 1));
      }
    }
  };

  for (const dir of ['core/compiler', 'core/renderer', 'core/reactivity']) {
    scan(join(ROOT, dir));
  }

  assert.deepEqual(
    offenders,
    [],
    `these must stay browser-compatible: ${offenders.join(', ')}`
  );
});

// Regression: the playground concatenates the compiler's modules into
// one scope, so two files defining the same top-level name is a syntax
// error that takes the whole bundle down — the page loaded, the compiler
// did not, and nothing in the suite noticed. Module scope hides this
// until the bundle is built.
test('no two compiler modules declare the same top-level name', () => {
  // The same list the playground bundler concatenates, in its order.
  const MODULES = [
    'core/buildError.js',
    'core/compiler/html.js',
    'core/compiler/parser.js',
    'core/compiler/sourceResolver.js',
    'core/compiler/resolveComponents.js',
    'core/compiler/compileToJs.js',
    'core/renderer/renderToHtml.js',
  ];

  const owners = new Map();
  const clashes = [];

  for (const relative of MODULES) {
    const source = readFileSync(join(ROOT, relative), 'utf8');

    // Top-level declarations only: no leading whitespace.
    const names = [
      ...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm),
      ...source.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm),
      ...source.matchAll(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm),
    ].map((match) => match[1]);

    for (const name of names) {
      const owner = owners.get(name);
      if (owner && owner !== relative) clashes.push(`${name} — ${owner} and ${relative}`);
      else owners.set(name, relative);
    }
  }

  assert.deepEqual(clashes, [], 'these names would collide once concatenated');
});
