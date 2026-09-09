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

## Getting Started

Azox is not on npm yet. To try it from a local checkout:

```bash
git clone https://github.com/darilpratomo/azox.git
cd azox
npm link          # makes the `azox` command available
```

Then scaffold a project:

```bash
azox create my-app
cd my-app
npm link azox     # until Azox is published
azox compile
```

The build lands in `.azox/build/` as a self-contained static bundle —
an HTML file, a compiled hydration module, and a copy of the runtime.
Serve that directory with any static server and the page works with
no install step:

```bash
cd .azox/build && python3 -m http.server 4321
```

## CLI

```
azox create <name>   Scaffold a new Azox project
azox compile         Compile pages/index.azox (--page=<name> for others)
azox doctor          Check that the toolchain and project are healthy
azox -v              Print the version
azox help            Show all commands
```

## Project Structure

```
azox/
├── bin/azox.js              CLI entry point
├── core/
│   ├── cli/                 argument parsing + command routing
│   ├── commands/             built-in CLI commands
│   ├── compiler/             .azox parser + compiler
│   ├── reactivity/           signal() / effect() / computed()
│   ├── renderer/             server-side HTML rendering
│   └── meta.js               version and identity strings
└── pages/                    example .azox pages
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
