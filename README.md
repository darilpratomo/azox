# Azox Framework

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

```bash
node bin/azox.js test
```

This compiles `pages/index.azox` into `.azox/build/`, producing a
static HTML shell plus a client module that hydrates it with live
signal bindings — no framework runtime beyond ~50 lines of reactivity
code.

## Project Structure

```
azox/
├── bin/azox.js              CLI entry point
├── core/
│   ├── cli/                 argument parsing + command routing
│   ├── commands/             built-in CLI commands
│   ├── compiler/             .azox parser + compiler
│   ├── reactivity/           signal() / effect() / computed()
│   └── renderer/             server-side HTML rendering
└── pages/                    example .azox pages
```

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
