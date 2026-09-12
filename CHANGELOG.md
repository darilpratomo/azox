# Changelog

Notable changes to Azox. The project is pre-1.0, so APIs may change
between minor versions; each such change is listed here.

## Unreleased

### Fixed

- **Hydration silently broke listeners another script had attached.**
  Mounting replaces everything inside the root, so a button bound by a
  plain `<script>` on the server-rendered markup came back looking
  right and doing nothing. Hydration now dispatches `azox:navigate`
  once it has mounted — the same event the router sends — so one
  listener covers both cases.
- **Inline SVG was invisible.** Elements were made with
  `createElement`, which always produces an HTML element, so an
  `<svg>` in a `.azox` page was laid out as an unknown HTML tag —
  present in the DOM, 0×0 on screen. `<svg>` and everything inside it
  now use `createElementNS`. Found on this site's own search button,
  which rendered as an empty box.

### Added

- **`azox:navigate`**, dispatched on `document` after the client-side
  router swaps a page and runs its module. A page's own module is
  re-run on navigation, but a classic `<script>` that enhances the
  markup — heading anchors, a table of contents, syntax highlighting —
  is not: it ran once on first load and the nodes it worked on have
  been replaced. `detail` carries `{ url, from }`.

## 1.0.1 — 2026-09-12

### Fixed

- **A multi-root component inside a keyed list could not be removed.**
  Such a component returns a `DocumentFragment`, which empties when it
  is inserted and has no `.remove()`, so a departing row threw
  `_node.remove is not a function`: the row stayed on screen and its
  `onCleanup` never ran. Rows now record the nodes a fragment held.
  Introduced with multi-root components in 1.0.0.

## 1.0.0 — 2026-09-12

The API is now stable. Everything below is what 1.0 commits to: the
template syntax, the reactivity exports, and the shape of the build
output will not change without a 2.0.

### Added

- **`bind:`** for two-way inputs. `bind:value={draft}` replaces a
  `value=` and an `on:input=` that have to agree. It picks the property
  and event from the element — a checkbox binds `checked` and listens
  for `change`, a `<select>` listens for `change` — and reads a number
  input as a number, so `qty * 2` gives `10` rather than `"52"`. The
  signal is named, not called: `bind:value={draft()}` cannot write back
  and is rejected.
- **Several root elements** in a page or component, collected into a
  fragment. A component had to have exactly one root, so returning a
  pair of `<li>`s meant a wrapper `<div>` that is not valid inside a
  `<ul>`.
- The main `azoxjs` entry now re-exports the whole reactivity surface,
  so it and `azoxjs/reactivity` offer the same thing.

### Changed

- **A static page ships no JavaScript at all.** A page with no bindings
  and no listeners arrives complete from the build, so the document no
  longer references a client module and none is written. It used to load
  one whose only job was to export a `render()` nothing called — and to
  pull in the runtime with it. On this site that removed 372 kB across
  fourteen pages.
- **An expression reading only build-time constants is folded into the
  markup** rather than wrapped in an effect. Every page here hydrated for
  one reason: a version badge read from `package.json`, a value that
  cannot change after the build. Folding it made fourteen of sixteen
  pages static. A constant whose every read was folded is no longer
  declared at all. The check is deliberately conservative — a call, an
  unknown name, or a dynamic index all mean "assume it changes".

### Fixed

- `bind:value` set the value with `setAttribute`, which sets only the
  *initial* value — so after a user typed, writing it changed nothing
  they could see. It is assigned as a property now.
- A bound value rendered the signal function rather than calling it,
  putting `() => v` into the server-rendered markup.
- `checked="false"` is still checked, so a falsy checkbox now omits the
  attribute entirely.
- The docs claimed an attribute expression could not hold a raw `>`.
  It can — the fix for `<` covered both.
- A stale client module left by an earlier build is removed when a page
  stops needing one, so a deployed site does not keep loading it.
- Two compiler modules defining the same top-level name broke the
  playground, which concatenates them into one scope — the page loaded
  and the compiler silently did not. A test now catches the collision
  before the bundle is built.

## 0.4.0 — 2026-09-12

### Added

- **Lifecycle hooks.** `onMount(fn)` runs once the DOM the scope built
  is in the document — the place to measure an element, focus an input,
  or start a timer. `onCleanup(fn)` runs when the scope goes away: a row
  leaving a keyed list, or a branch of an `<if>` no longer taken. A
  function returned from `onMount` becomes its cleanup, so setup and
  teardown can stay in one place. A cleanup that throws is reported and
  does not stop the others.
- **`untracked(fn)`** runs a callback with no effect considered active,
  so what it creates is owned by nobody and survives the caller
  re-running.

### Fixed

- **A surviving row in a keyed list stopped being reactive.** Rows were
  built inside the list's own effect, which made each one its child, so
  re-running the list tore down every row that survived — its bindings
  stopped updating and it sat on screen frozen, which is the opposite of
  what keying promises. Rows are now created with `untracked`.
- Runtime bindings are merged into one import statement. A page writing
  `azox/reactivity` and a keyed list needing the same binding produced
  two imports that the build rewrote to the same path — a redeclaration,
  so the module never ran. The specifier the author wrote is kept, since
  rewriting it is the build's job and the playground has no build.

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
