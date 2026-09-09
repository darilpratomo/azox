# Azox Framework

[![CI](https://github.com/darilpratomo/azox/actions/workflows/ci.yml/badge.svg)](https://github.com/darilpratomo/azox/actions/workflows/ci.yml)

**The Sound of Future Web**

Azox is a web framework built from scratch — no Virtual DOM, no
third-party CLI dependencies, no borrowed syntax from React, Vue, or
Next.js. It compiles `.azox` components directly into fine-grained,
signal-driven DOM updates.

> Status: early development (v0.0.1). APIs are unstable and will
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

In this version components are presentational: they take props and
render markup, and state lives in the page that uses them. A
component that declares its own logic is rejected with an explicit
error rather than quietly sharing the caller's scope.

## Getting Started

Azox is not on npm yet. To try it from a local checkout:

```bash
git clone https://github.com/darilpratomo/azox.git
cd azox
npm link          # makes the `azox` command available
```

Then scaffold a project and start the dev server:

```bash
azox create my-app
cd my-app
npm link azox     # until Azox is published
azox dev
```

`azox dev` serves the project at `http://localhost:4321`, rebuilds on
every save, and reloads the browser. When a page fails to compile it
serves the error instead of stale output, then recovers on its own
once the page is fixed.

For a production build:

```bash
azox compile
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
