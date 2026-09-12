import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAll, buildPage, listRoutes, BuildError } from '../core/build.js';

// A bracketed segment in a filename is a parameter, so one file builds
// many pages: pages/blog/[slug].azox declares its own pages through
// routes(), and reads the one it is building through params().

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'azox-dyn-'));
  mkdirSync(join(dir, 'pages/blog'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dyn', type: 'module' }));

  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content);
  }

  return dir;
}

const posts = JSON.stringify([
  { slug: 'hello', title: 'Hello world' },
  { slug: 'second', title: 'Second post' },
]);

const template = `<script>
  import posts from '../../posts.json' with { type: 'json' };

  routes(posts.map((p) => ({ slug: p.slug })));

  const { slug } = params();
  const post = posts.find((p) => p.slug === slug);
</script>
<article><h1>{post.title}</h1></article>`;

test('a template is recognised as one, not as a route of its own', () => {
  const dir = project({ 'posts.json': posts, 'pages/blog/[slug].azox': template });

  try {
    const [route] = listRoutes(dir);

    assert.equal(route.isTemplate, true);
    assert.deepEqual(route.paramNames, ['slug']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one file builds a page per declared entry', () => {
  const dir = project({ 'posts.json': posts, 'pages/blog/[slug].azox': template });

  try {
    const results = buildAll(dir);

    assert.deepEqual(
      results.map((r) => r.url).sort(),
      ['/blog/hello', '/blog/second']
    );
    assert.match(readFileSync(join(dir, '.azox/build/blog/hello/index.html'), 'utf8'), /Hello world/);
    assert.match(readFileSync(join(dir, '.azox/build/blog/second/index.html'), 'utf8'), /Second post/);

    // The template's own url is never written.
    assert.equal(existsSync(join(dir, '.azox/build/blog/[slug]')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: routes() and params() are build-time declarations. Left
// in the emitted module they threw "routes is not defined" in the
// browser, which stopped hydration and left the page inert.
test('the client module carries neither routes() nor params()', () => {
  const dir = project({ 'posts.json': posts, 'pages/blog/[slug].azox': template });

  try {
    const [first] = buildAll(dir);
    const code = readFileSync(first.clientPath, 'utf8');

    assert.doesNotMatch(code, /\broutes\s*\(/, 'routes() must not reach the browser');
    assert.doesNotMatch(code, /\bparams\s*\(/, 'params() must not reach the browser');
    // The values are inlined in its place.
    assert.match(code, /\{"slug":"(hello|second)"\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each page gets only its own parameters', () => {
  const dir = project({ 'posts.json': posts, 'pages/blog/[slug].azox': template });

  try {
    buildAll(dir);

    const hello = readFileSync(join(dir, '.azox/build/blog/hello/page.client.js'), 'utf8');
    const second = readFileSync(join(dir, '.azox/build/blog/second/page.client.js'), 'utf8');

    assert.match(hello, /\{"slug":"hello"\}/);
    assert.match(second, /\{"slug":"second"\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a filename may hold more than one parameter', () => {
  const dir = project({});

  try {
    mkdirSync(join(dir, 'pages/blog/[lang]'), { recursive: true });
    writeFileSync(
      join(dir, 'pages/blog/[lang]/[slug].azox'),
      `<script>
  routes([
    { lang: 'en', slug: 'intro' },
    { lang: 'id', slug: 'intro' },
  ]);
  const { lang, slug } = params();
</script>
<p>{lang}/{slug}</p>`
    );

    const results = buildAll(dir);

    assert.deepEqual(
      results.map((r) => r.url).sort(),
      ['/blog/en/intro', '/blog/id/intro']
    );
    assert.match(readFileSync(join(dir, '.azox/build/blog/en/intro/index.html'), 'utf8'), /en\/intro/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ordinary pages build alongside generated ones', () => {
  const dir = project({
    'posts.json': posts,
    'pages/blog/[slug].azox': template,
    'pages/index.azox': '<main>home</main>',
  });

  try {
    const results = buildAll(dir);

    assert.deepEqual(
      results.map((r) => r.url).sort(),
      ['/', '/blog/hello', '/blog/second']
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a generated page can be built on its own by url', () => {
  const dir = project({ 'posts.json': posts, 'pages/blog/[slug].azox': template });

  try {
    const result = buildPage(dir, '/blog/hello');

    assert.equal(result.url, '/blog/hello');
    assert.match(readFileSync(result.htmlPath, 'utf8'), /Hello world/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('naming the template builds every page it declares', () => {
  const dir = project({ 'posts.json': posts, 'pages/blog/[slug].azox': template });

  try {
    const results = buildPage(dir, 'blog/[slug]');

    assert.ok(Array.isArray(results));
    assert.equal(results.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A template cannot guess its own pages, so the omission has to be
// reported rather than producing nothing.
test('a template with no routes() call is reported', () => {
  const dir = project({
    'pages/blog/[slug].azox': `<script>
  const { slug } = params();
</script>
<p>{slug}</p>`,
  });

  try {
    assert.throws(() => buildAll(dir), (error) => {
      assert.ok(error instanceof BuildError);
      assert.match(error.message, /must declare its pages/);
      assert.match(error.message, /routes\(\[\.\.\.\]\)/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an entry missing a parameter the filename asks for is reported', () => {
  const dir = project({
    'pages/blog/[slug].azox': `<script>
  routes([{ wrong: 'x' }]);
  const { slug } = params();
</script>
<p>{slug}</p>`,
  });

  try {
    assert.throws(() => buildAll(dir), /missing "slug"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A parameter fills one url segment, so a slash in its value would
// silently create a directory level the author never declared.
test('a parameter containing a slash is reported', () => {
  const dir = project({
    'pages/blog/[slug].azox': `<script>
  routes([{ slug: 'a/b' }]);
  const { slug } = params();
</script>
<p>{slug}</p>`,
  });

  try {
    assert.throws(() => buildAll(dir), /contains a "\/"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Two entries producing one url would have one quietly overwrite the
// other, leaving a page missing with nothing to show why.
test('two entries producing the same url are reported', () => {
  const dir = project({
    'pages/blog/[slug].azox': `<script>
  routes([{ slug: 'x' }, { slug: 'x' }]);
  const { slug } = params();
</script>
<p>{slug}</p>`,
  });

  try {
    assert.throws(() => buildAll(dir), /declares \/blog\/x twice/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routes() given something other than an array is reported', () => {
  const dir = project({
    'pages/blog/[slug].azox': `<script>
  routes('nope');
  const { slug } = params();
</script>
<p>{slug}</p>`,
  });

  try {
    assert.throws(() => buildAll(dir), /needs an array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routes() given an empty list is reported', () => {
  const dir = project({
    'pages/blog/[slug].azox': `<script>
  routes([]);
  const { slug } = params();
</script>
<p>{slug}</p>`,
  });

  try {
    assert.throws(() => buildAll(dir), /nothing to write/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: require caches by path, so a build running more than
// once in a process — which is every `azox dev` rebuild — kept serving
// the data as it was at startup.
test('a second build in the same process sees edited data', () => {
  const dir = project({ 'posts.json': posts, 'pages/blog/[slug].azox': template });

  try {
    assert.equal(buildAll(dir).length, 2);

    writeFileSync(
      join(dir, 'posts.json'),
      JSON.stringify([
        { slug: 'hello', title: 'Hello world' },
        { slug: 'second', title: 'Second post' },
        { slug: 'third', title: 'Third post' },
      ])
    );

    const again = buildAll(dir);

    assert.equal(again.length, 3, 'the new entry must appear without restarting');
    assert.match(readFileSync(join(dir, '.azox/build/blog/third/index.html'), 'utf8'), /Third post/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Removing an entry must remove its page, the same way deleting a file
// does — otherwise a deployed site keeps serving it.
test('output for a removed entry is cleaned up', () => {
  const dir = project({ 'posts.json': posts, 'pages/blog/[slug].azox': template });

  try {
    buildAll(dir);
    assert.ok(existsSync(join(dir, '.azox/build/blog/second/index.html')));

    writeFileSync(join(dir, 'posts.json'), JSON.stringify([{ slug: 'hello', title: 'Hello world' }]));
    buildAll(dir);

    assert.equal(existsSync(join(dir, '.azox/build/blog/second/index.html')), false);
    assert.ok(existsSync(join(dir, '.azox/build/blog/hello/index.html')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
