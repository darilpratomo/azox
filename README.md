# Azox Framework

[![CI](https://github.com/darilpratomo/azox/actions/workflows/ci.yml/badge.svg)](https://github.com/darilpratomo/azox/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/azoxjs.svg)](https://www.npmjs.com/package/azoxjs)
[![install size](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/azoxjs)

**The Sound of Future Web**

Azox is a web framework built from scratch — no Virtual DOM, no
third-party CLI dependencies, no borrowed syntax from React, Vue, or
Next.js. It compiles `.azox` components directly into fine-grained,
signal-driven DOM updates.

> Status: early development (v0.3.0). APIs are unstable and will
> change without notice until v1.0.

## Why Azox

Most frameworks solve reactivity with a Virtual DOM (React) or a
build-time compiler that inlines everything (Svelte). Azox takes a
third path: **fine-grained signals**. Every dynamic binding in your
template compiles to its own tiny `effect()` that writes directly to
the one DOM node it owns. No tree diffing, no wasted re-renders.

```html
<script>
  import { signal } from 'azox/reactivity';
  const count = signal(0);
</script>

<button on:click={() => count.set(count() + 1)}>
  Clicks: {count()}
</button>
```

## Routing

The file layout is the routing table. A page becomes a directory with
an `index.html`, so URLs carry no extension and work on any static
host without rewrite rules.

```
pages/index.azox            →  /
pages/about.azox            →  /about
pages/blog/index.azox       →  /blog
pages/blog/first-post.azox  →  /blog/first-post
```

```
.azox/build/
├── index.html
├── page.client.js
├── azox-runtime.js          one runtime, shared by every page
├── about/
│   ├── index.html
│   └── page.client.js
└── blog/
    ├── index.html
    ├── page.client.js
    └── first-post/
        ├── index.html
        └── page.client.js
```

Build one page with `azox compile --page=blog/first-post`, or by its
URL: `azox compile --page=/blog/first-post`.

### Dynamic routes

A bracketed segment in a filename is a parameter, and the file becomes
a template that builds one page per entry it declares:

```html
<!-- pages/blog/[slug].azox -->
<script>
  import posts from '../../posts.json' with { type: 'json' };

  // Which pages to build.
  routes(posts.map((p) => ({ slug: p.slug })));

  // The parameters of the page being built.
  const { slug } = params();
  const post = posts.find((p) => p.slug === slug);
</script>

<article>
  <h1>{post.title}</h1>
  <p>{post.body}</p>
</article>
```

```
posts.json with two entries  →  /blog/hello
                             →  /blog/second
```

`routes()` takes an array of objects, one per page, each supplying
every parameter the filename asks for. A filename may hold several
(`pages/[lang]/[slug].azox`), and `params()` returns them all.

Both are build-time declarations: neither reaches the browser. The
parameters for each page are compiled into its module as a constant.

A missing `routes()` call, an entry missing a parameter, a value
containing a `/`, and two entries producing the same URL are all
reported as build errors rather than producing a broken site.

## Components

A component is a `.azox` file that declares what it accepts and
renders markup. Import it, then use it as a capitalised tag:

```html
<!-- components/Card.azox -->
<script>
  const { title, body } = props();
</script>

<article class="card">
  <h2>{title}</h2>
  <p>{body}</p>
</article>
```

```html
<!-- pages/index.azox -->
<script>
  import Card from '../components/Card.azox';
  import { signal } from 'azox/reactivity';

  const count = signal(0);
</script>

<main>
  <Card title="Live" body={count()} />
  <button on:click={() => count.set(count() + 1)}>Add one</button>
</main>
```

Components are resolved at build time: the markup is inlined into the
caller, so there is no component instance and no per-component
overhead at runtime. A prop passed as an expression stays reactive
across the boundary — clicking the button above updates the text
inside the card and nothing else. A prop passed as a plain string
compiles to static text with no effect attached.

`<slot />` renders whatever the caller nested inside the tag:

```html
<!-- components/Layout.azox -->
<script>
  const { heading } = props();
</script>

<section>
  <header>{heading}</header>
  <slot />
</section>
```

Declaring props with `props()` is what lets the compiler reject a
caller that passes something the component never asked for, instead
of dropping it silently.

A component may hold its own state. Its `<script>` becomes a scope
of its own, so two uses of the same component are independent — each
`<Counter />` below counts separately:

```html
<!-- components/Counter.azox -->
<script>
  import { signal } from 'azox/reactivity';
  const count = signal(0);
</script>

<button on:click={() => count.set(count() + 1)}>{count()}</button>
```

```html
<main>
  <Counter />
  <Counter />
</main>
```

There is still no component instance at runtime: the compiler wraps
each use in its own JavaScript scope, which is ordinary scoping
rather than a framework construct.

## Lifecycle

`onMount` runs once the DOM is in the document; `onCleanup` runs when
the scope goes away.

```html
<script>
  import { signal, onMount, onCleanup } from 'azox/reactivity';

  const width = signal(0);
  let box;

  onMount(() => {
    // The nodes exist now, so they can be measured.
    const onResize = () => width.set(box.clientWidth);
    onResize();

    window.addEventListener('resize', onResize);
    // Returned from onMount, so it is the cleanup for this setup.
    return () => window.removeEventListener('resize', onResize);
  });

  onCleanup(() => console.log('gone'));
</script>

<div>{width()}px</div>
```

A scope goes away when a row leaves a keyed list, or when an `<if>`
takes the other branch. At the top level of a page nothing ever removes
it, so `onCleanup` there never runs — that is a page living as long as
the document, not a failure.

## Layouts and the document head

A component can carry a `<head>` block, so one shared component holds
the stylesheet, fonts and scripts every page needs:

```html
<!-- components/Shell.azox -->
<head>
  <link rel="stylesheet" href="/style.css" />
</head>

<div class="shell">
  <header>My site</header>
  <slot />
</div>
```

```html
<!-- pages/index.azox -->
<head>
  <title>Home — my site</title>
</head>

<script>
  import Shell from '../components/Shell.azox';
</script>

<Shell><main>Just this page's content.</main></Shell>
```

Blocks are merged with the component's first, so the page has the last
word. Identical lines are emitted once, and a component used twice
contributes once. A `<title>` or `<meta name="…">` set by the page
replaces the component's rather than joining it — a document may hold
only one of each — so a layout's title is a default, not a conflict.

## Loops and conditionals

Control flow is expressed as tags, so it nests inside markup like
anything else.

```html
<ul>
  <each item={todos()} as="todo" index="i">
    <li>{i + 1}. {todo}</li>
  </each>
</ul>

<if cond={user()}>
  <p>Signed in as {user().name}</p>
<else />
  <a href="/login">Sign in</a>
</if>
```

Each block marks its place with a pair of comment nodes, and an
update replaces only the nodes between them.

By default a change to a list rebuilds its rows. Give a row an
identity with `key` and it survives instead: reordering moves it,
removing one leaves the rest untouched, and adding one does not
disturb what is already there.

```html
<each item={tasks()} as="task" key={task.id}>
  <li><TaskRow title={task.title} /></li>
</each>
```

Use something stable and unique to the row — a database id, not its
position, since a position changes when the list does.

## Client-side routing

By default every link is a full page load, which is the right
behaviour for a static site. Opt in to client-side navigation with
`router: true` in your project's `package.json`:

```json
{
  "router": true
}
```

Internal links are then swapped in place: the new page's HTML is
fetched, the document body and `<head>` are replaced, and its module
runs. Scroll position, the back button, and `<a target>` all behave
as they would with a full load. A link is prefetched when the pointer
enters it, so the page is usually already in hand by the time it is
clicked.

Anything the router cannot handle — an external origin, a download,
a modifier-click — falls through to the browser untouched.

## Importing data

A `<script>` block may import a `.json` file, which is how a page
reads a constant it should not have written out by hand:

```html
<script>
  import pkg from '../package.json' with { type: 'json' };
</script>

<span>v{pkg.version}</span>
```

The file is read once during the build. Server rendering evaluates
against it, and the value is compiled into the module as a constant
rather than imported — the file sits outside the build directory and
is never deployed, so an import would 404 in the browser.

Only the properties the markup reads are included, so importing
`package.json` for a version does not ship the rest of the file to
every visitor.

Importing a `.js` module is not supported: it would mean executing
project code during the build. Use a `.json` file for data, and
`azox/reactivity` for signals.

## Getting Started

The package on npm is `azoxjs`; the CLI it installs is `azox`.

```bash
npx azoxjs create my-app
cd my-app
npm install
npm run dev
```

`azox dev` serves the project at `http://localhost:4321`, rebuilds on
every save, and reloads the browser. When a page fails to compile it
serves the error instead of stale output, then recovers on its own
once the page is fixed.

For a production build:

```bash
npm run build
```

The build lands in `.azox/build/` as a self-contained static bundle —
an `index.html` per route, a compiled hydration module beside it, and
one shared copy of the runtime. No dev machinery is included. Serve
that directory with any static host and it works with no install
step and no rewrite configuration.

## CLI

```
azox create <name>   Scaffold a new Azox project
azox dev             Serve the project, rebuilding on every change
azox compile         Build every page (--page=<name|url> for one)
azox doctor          Check that the toolchain and project are healthy
azox -v              Print the version
azox help            Show all commands
```

`azox dev` takes `--port=<n>` and `--host=<addr>`. If the port is
busy it steps forward to the next free one rather than failing.

## Project Structure

```
azox/
├── bin/azox.js              CLI entry point
├── core/
│   ├── cli/                 argument parsing + command routing
│   ├── commands/             built-in CLI commands
│   ├── compiler/             .azox parser, component resolver, compiler
│   ├── dev/                  dev server, file watching, live reload
│   ├── reactivity/           signal() / effect() / computed()
│   ├── renderer/             server-side HTML rendering
│   ├── router/               opt-in client-side navigation
│   ├── build.js              the build pipeline, shared by commands
│   ├── routes.js             file layout → urls and output paths
│   └── meta.js               version and identity strings
├── pages/                    example .azox pages
└── components/               example .azox components
```

## Tests

```bash
npm test
```

The suite runs on Node's built-in test runner — no test framework
dependency. It covers the reactivity primitives, the parser, the
compiler's emitted code, HTML escaping in the server renderer, CLI
argument parsing, and an end-to-end pass that compiles a fixture
project and executes the output to confirm the page really is
reactive.

## Design Principles

1. **Zero dependencies at the core.** No Commander, no Yargs, no
   Virtual DOM library. The CLI and compiler are written in plain
   JavaScript.
2. **Fine-grained reactivity, not a Virtual DOM.** Updates target
   exact DOM nodes, not a re-rendered tree.
3. **Its own syntax.** `.azox` files are not JSX. They're closer to
   plain HTML with `{expr}` interpolation and `on:event` bindings.

## License

MIT — see [LICENSE](./LICENSE).
