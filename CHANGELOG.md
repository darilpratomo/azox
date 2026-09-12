# Changelog

Notable changes to Azox. The project is pre-1.0, so APIs may change
between minor versions; each such change is listed here.

## 0.3.0 — 2026-09-12

### Added

- **Dynamic routes.** A bracketed segment in a filename is a
  parameter, so `pages/blog/[slug].azox` builds one page per entry:
  `routes([...])` declares which pages to build and `params()` returns
  the ones being built. Both are build-time declarations and neither
  reaches the browser — each page's parameters are compiled into its
  module as a constant. A missing `routes()` call, an entry missing a
  parameter, a value containing a `/`, and two entries producing the
  same url are all reported as build errors.

- **A component may carry a `<head>` block.** One shared component can
  now hold the stylesheet, fonts and scripts every page needs, instead
  of each page repeating them. Blocks are merged behind the page's own,
  identical lines are emitted once, and a component used twice
  contributes once. A `<title>` or a `<meta name>` set by the page
  replaces the component's, since a document may hold only one of
  each — so a layout's title is a default rather than a conflict.

### Fixed

- `azox dev` did not rebuild when a `.json` file a page imports
  changed, so editing a post's content or adding one changed nothing
  on screen. The project root's `.json` files are now watched, and the
  require cache is dropped per build — it caches by path, so every
  rebuild in a long-running dev server had been reusing the data as it
  was when the server started.

## 0.2.0 — 2026-09-12

### Added

- **Loops and conditionals as tags.** `<each item={} as="" index="">`
  and `<if cond={}>…<else />…</if>`, nestable inside ordinary markup.
  Each block marks its place with a pair of comment nodes, so an
  update touches only the nodes between them.
- **Keyed lists.** `<each … key={item.id}>` gives a row an identity,
  so reordering moves it, removing one leaves the rest untouched, and
  adding one does not disturb what is already there. Without a key a
  list still rebuilds, which remains the right default for plain text.
- **Stateful components.** A component's `<script>` is now its own
  scope, so two uses of the same component are independent. There is
  still no component instance at runtime — the compiler wraps each use
  in an ordinary JavaScript scope.
- **Opt-in client-side routing.** Set `"router": true` in the
  project's `package.json`. Internal links are swapped in place, with
  the page prefetched when the pointer enters the link. Scroll
  position, the back button and `<a target>` behave as with a full
  load; external origins, downloads and modifier-clicks fall through
  to the browser.
- **JSON imports in a `<script>` block.** `import pkg from
  '../package.json' with { type: 'json' }` reads a constant at build
  time; the value is inlined into the module rather than imported, and
  narrowed to the properties the markup reads so the rest of the file
  is not published. Importing a `.js` module is reported as
  unsupported rather than failing in the renderer.
- **Page `<head>` blocks** and `<text>` for literal content.
- **Static assets** from `public/`, copied into the build.
- **A browser-capable compiler.** The compiler no longer touches Node
  built-ins, so it runs unchanged in a browser — this is what powers
  the playground on azox.dev.

### Fixed

- An expression containing `<` — `{a() < b()}`, an ordinary
  comparison — failed to parse as an unterminated tag. Text was
  scanned to the next `<` with no awareness of expressions, which
  broke `` {`<b>x</b>`} `` the same way.
- A mistyped CLI flag was ignored: `azox compile --pge=about` built
  every page and reported success. Unknown flags are now rejected.
- Deleting a page left its built output behind, so a deployed site
  kept serving a page that no longer existed. Each build now removes
  the generated files it did not write. Public assets, the shared
  runtime and a user's own `index.html` are never touched.
- Slot content could not see the caller's scope during server
  rendering, so a page changed on hydration. The compiled path was
  already correct; only the renderer disagreed.
- A second `<else />` leaked into the output as `<else></else>`. It is
  now a parse error.
- `<each>` over a non-iterable reported an internal variable name
  instead of the author's expression.
- The dev server watched only `pages/` and only `.azox` files, so
  editing a component or a stylesheet did nothing. It now watches
  `pages/`, `components/` and `public/`.
- Control flow inside a component did not update.
- A nested page imported the runtime from its own directory, where no
  runtime exists, so every page below the top level 404'd on it.
- An import hoisted out of a component was rebased against the page's
  directory rather than the component's, so a component importing a
  file next to itself pointed at nothing.
- A component whose `<script>` held only an import had that import
  dropped, because a component with no other logic is inlined outright
  — leaving the name its markup referenced undefined.
- The runtime specifier was rewritten by matching the bare string
  `azox` anywhere in the emitted module, so data that merely contained
  it was corrupted. It is now anchored to an import statement.

### Changed

- The scaffold from `azox create` now demonstrates independent
  component state, a keyed list, and an input that adds to it.

## 0.1.0 — 2026-09-09

First published release.

- `signal()` / `effect()` / `computed()` — fine-grained reactivity
  with no Virtual DOM.
- A compiler for `.azox` files: HTML with `{expr}` interpolation and
  `on:event` bindings, emitted as direct DOM updates.
- Build-time component composition with `props()` and `<slot />`.
- File-based routing with directory-style clean URLs, so a built site
  needs no rewrite rules.
- Server-side rendering, with client hydration.
- `azox create` / `dev` / `compile` / `doctor` / `version` / `help`,
  with rebuild and live reload in dev.
- Zero runtime dependencies.

Published to npm as `azoxjs`; the name `azox` was rejected by npm's
anti-typosquatting check. The CLI it installs is still `azox`.
