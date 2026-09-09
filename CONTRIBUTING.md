# Contributing to Azox

Azox is in early development. Interfaces change often, so open an
issue before starting anything large — it may already be planned, or
about to be reworked.

## Setup

```bash
git clone https://github.com/darilpratomo/azox.git
cd azox
npm link      # exposes the `azox` command, pointing at your checkout
npm test
```

There are no dependencies to install. Azox targets Node 18+ and uses
only the standard library.

## Ground rules

1. **No runtime dependencies in `core/`.** The CLI, the compiler and
   the reactivity runtime are written against the Node and browser
   standard libraries. A dependency needs a strong argument.
2. **No Virtual DOM.** Updates are fine-grained: a binding writes to
   the exact node it owns. Anything that reintroduces tree diffing
   works against the point of the project.
3. **`.azox` is not JSX.** The syntax is HTML with `{expr}`
   interpolation and `on:event` bindings. Keep it that way.

## Tests

```bash
npm test              # everything
node --test test/parser.test.js   # one file
```

New behaviour needs a test. Fixed bugs need a regression test that
fails without the fix — several tests in `test/` exist precisely
because something broke silently once.

The suite covers:

| File | Covers |
| --- | --- |
| `test/reactivity.test.js` | `signal()`, `effect()`, `computed()` |
| `test/parser.test.js` | `.azox` → AST, including malformed input |
| `test/compiler.test.js` | the JavaScript the compiler emits |
| `test/renderer.test.js` | server-rendered HTML and escaping |
| `test/cli.test.js` | argument parsing |
| `test/build-api.test.js` | the build pipeline as a module |
| `test/dev-server.test.js` | static serving, path traversal, live reload |
| `test/build.test.js` | the CLI end to end, on real temp projects |

## Commits

Explain what changed and why in the body. If you fixed something
subtle, say what the wrong behaviour was — that context is worth more
than the diff.
