# Adopting server markup on hydration

Status: in progress. This records the decision before the code, since
the change spans the renderer and every emitter in the compiler.

## What happens today

`hydrateBlock()` runs `mount.innerHTML = ''` and rebuilds the page from
scratch. Measured on a page with an input, a `<details>` and a list:

| | before | after |
|---|---|---|
| focus | `#field` | none |
| caret | 3 | 0 |
| `<details>` open | true | false |
| scroll | 500 | 500 |

Focus, caret and expanded state are destroyed. Scroll survives, because
the browser restores it independently — an earlier note in this project
claimed otherwise and was wrong.

## Why it cannot simply walk the existing nodes

The client anchors every `<if>` and `<each>` on two empty comment
nodes, and every later update works from `end.parentNode` and
`insertBefore(node, end)`. The server emits no comments at all:

    server : <ul><li>a</li><li>b</li></ul>
    client : createComment() × 2, then the rows between them

On the same page the counts are 0 comments from the server against 4
from the client. So there is nothing in the server's output for an
adopting walker to align on: it cannot tell where a list begins, which
element belongs to which row, or where to put the markers it needs for
the next update.

## The options

**A. The server emits the markers too.** The renderer writes the same
start/end pair around each control-flow region, and the walker adopts
them as the very nodes it will later mutate. Costs a few bytes per
block in the HTML.

**B. Adopt static subtrees only, rebuild control flow.** No HTML
change, but a page with a list still loses focus inside it — a partial
fix for most of the complexity.

**C. Match by position, no markers.** Walk children by index and infer
boundaries from the data. Breaks silently the moment the data differs
between build and load, producing a DOM that looks right and is wrong.

## Decision: A

C is rejected outright: silent corruption is worse than the bug being
fixed. B leaves the common case — a list of interactive rows — no
better off.

Measured: two comments are 15 bytes per block, 0.13% of an 11 KB
hydrating page. A costs nothing where it matters most. The 14 static pages of this site
ship no JavaScript at all, and a page containing `<each>` or `<if>`
always emits an `effect`, so it was never static to begin with. Markers
therefore only appear on pages that were already hydrating. Against an
11 KB page, a few comment nodes are noise.

It is also what Svelte, Solid and Vue settled on, for the same reason.

## Step 2: the adopt walker — analysis

Step 1 is done: both sides emit `<!--[-->` and `<!--]-->`, verified
2-for-2 on a real build. Behaviour is deliberately unchanged — the
markers are anchors for a walker that does not exist yet.

### Every creation site needs a second mode

Adoption means each `document.create*` call becomes "take the next
expected node, verify it matches, otherwise give up and rebuild". The
sites, all read:

| emitter | creates | adopt mode must |
|---|---|---|
| `emitNode` element branch | `createElement` / `createElementNS` | take the next element, check `tagName` |
| `emitNode` fragment branch | `createDocumentFragment` | walk in place, no node of its own |
| `emitText` static | `createTextNode(value)` | reuse the server's text node |
| `emitText` dynamic | `createTextNode('')` + `effect` | reuse it, then bind the effect |
| `emitScope` | component IIFE | walk its single root |
| `emitControlBlock` | marker pair + fragment | adopt the pair, walk between |
| `emitKeyedEach` | marker pair + row map | recover each row's identity from the DOM |
| `emitPlainEach` / `emitIf` | via `emitControlBlock` | as above |
| `appendChildren` | `appendChild` | advance a cursor instead |

`appendChildren` is nearly a single choke point — two call sites, both
inside `emitNode` — which is where the cursor should live.

### `appendChild` is not a no-op, and that is the whole trap

The first working walker adopted every node correctly and still emptied
the page: the probe measured `<main></main>` with `inputCount: 0`, worse
than the rebuild it replaced.

The cause is that `appendChild` on a node that is already a child
*detaches and re-attaches* it, which rewrites `nextSibling` for whatever
preceded it. The walker reads `nextSibling` lazily, so appending each
adopted child pushes it behind the cursor. Measured in isolation on
`<a><b><i>`:

    adopted in order    : A, B, I     (correct)
    final child order   : A, B, I     (correct)
    cursor pointer after: A           (wrong — it should be null)

`done()` then walks forward from A and removes all three. Adoption was
never wrong; the sweep was, because the pointer had been re-seeded
behind it.

So an adopted node must not be appended at all — it is already in
position. Only a created node needs appending, which means the emitted
code has to distinguish the two cases at runtime rather than funnelling
both through one `appendChild`. The table above already said
`appendChildren` should "advance a cursor instead"; the first
implementation appended as well, and that was the bug.

### The redundant append costs the focus it was meant to save

Snapshotting the child list stopped the sweep from deleting the page,
and the caret and the open `<details>` then survived — but focus still
landed on `BODY`. The node itself was fine: `sameInput` was true and a
manual `focus()` afterwards worked.

Appending is what loses it. Measured in isolation, on a focused input
that is already a child:

    host.appendChild(input)   // input is already host's child
    focus: "z" -> "BODY",  caret: 2 -> 2,  same node: true

`appendChild` on an existing child detaches and re-attaches it, and
detaching a focused element blurs it. So an adopted node must not be
appended at all — it is already in position. The emitter keeps what the
cursor returned in its own binding and appends only when that binding is
empty:

    const _el4 = _el2?.next("input");
    const _el3 = _el4 ?? document.createElement("input");
    if (!_el4) _el0.appendChild(_el3);

With that, the measured result on the step-2 fixture is focus, caret and
`<details>` all preserved, on the server's own nodes.

### Why it cannot land half-done

A tree where some emitters adopt and others create produces a DOM that
is part server, part client, with effects bound to nodes that are no
longer in the document. That is worse than today, which at least works.
So this is one change, not a series.

### The fallback is the safety property

Any mismatch — a tag that differs, a missing node, a text node where an
element was expected — must abandon adoption and rebuild the whole
root. A stale cache or an edited page then behaves exactly as it does
now. Without that, adoption fails silently and the page looks right
while being wrong.

### Keyed lists are the hard part, and go last

A keyed row's identity lives in the data, not the DOM. Adopting one
means recovering which server-rendered nodes belong to which key,
which the markers alone do not say. The options are a per-row marker
carrying the key, or accepting a rebuild for keyed lists only. That
decision is not yet made.

## Order of work

1. Renderer emits markers around `<if>` and `<each>`. Self-contained,
   verifiable by comparing server output to the shape the client builds.
2. An adopt path for static subtrees, behind the existing `render()`
   signature — the router and the tests depend on it. **Done**, with one
   restriction: a page that emits any control-flow block keeps the old
   wholesale rebuild. Adopting the markup around a block that still
   rebuilds itself would bind effects across two generations of nodes,
   which the section above rules out. `render()` takes an optional
   cursor as a second argument and creates when it is absent, so the
   router and the DOM stubs in the tests are unaffected.
3. Control flow: adopt between the markers rather than rebuilding.
4. Keyed lists last. They are the hardest: a row's identity has to be
   recovered from the DOM, not just its position.

A mismatch between what the server sent and what the compiler expects
must fall back to a full rebuild rather than guess. A wrong adoption is
invisible; a rebuild is merely the behaviour we have now.
