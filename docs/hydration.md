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

## Order of work

1. Renderer emits markers around `<if>` and `<each>`. Self-contained,
   verifiable by comparing server output to the shape the client builds.
2. An adopt path for static subtrees, behind the existing `render()`
   signature — the router and the tests depend on it.
3. Control flow: adopt between the markers rather than rebuilding.
4. Keyed lists last. They are the hardest: a row's identity has to be
   recovered from the DOM, not just its position.

A mismatch between what the server sent and what the compiler expects
must fall back to a full rebuild rather than guess. A wrong adoption is
invisible; a rebuild is merely the behaviour we have now.
