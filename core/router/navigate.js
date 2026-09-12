// Client-side navigation for Azox.
//
// Swaps one page's markup for another without a full reload, and
// keeps the browser's history in step. Deliberately small: there is
// no route table, no matching, and no component tree to keep alive —
// the server already produced every page, so navigating is fetching
// the next one and putting it in place.
//
// Everything here is an enhancement over links that already work.
// With the script absent or broken, an <a> is still an <a>.

const ROOT = '[data-azox-root]';
const PREFETCH_LIMIT = 24;

// Documents already fetched, keyed by URL. Bounded so a long session
// browsing a large site cannot grow it without limit.
const cache = new Map();

let currentUrl = location.href;

/** Starts intercepting navigation. Safe to call more than once. */
export function startRouter(options = {}) {
  if (typeof document === 'undefined' || document.__azoxRouter) return;
  document.__azoxRouter = true;

  const prefetch = options.prefetch !== false;

  document.addEventListener('click', onClick);
  window.addEventListener('popstate', onPopState);

  if (prefetch) {
    document.addEventListener('pointerenter', onPointerEnter, { capture: true });
    document.addEventListener('touchstart', onPointerEnter, { capture: true, passive: true });
  }
}

function onClick(event) {
  // Leave anything the browser should handle itself: modified clicks
  // open in a new tab or window, and a non-primary button is not a
  // plain navigation.
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const link = event.target.closest?.('a');
  const url = navigableUrl(link);
  if (!url) return;

  event.preventDefault();

  // Clicking the current page's own link should not push a duplicate
  // entry onto the history stack.
  if (url.href === location.href) return;

  history.pushState(null, '', url.href);
  go(url.href);
}

function onPopState() {
  go(location.href, { restore: true });
}

function onPointerEnter(event) {
  const link = event.target?.closest?.('a');
  const url = navigableUrl(link);
  if (url) load(url.href);
}

// Decides whether a link is one this router should handle. Anything
// off-site, downloadable, or explicitly opted out is left alone.
function navigableUrl(link) {
  if (!link || !link.href) return null;
  if (link.target && link.target !== '_self') return null;
  if (link.hasAttribute('download') || link.hasAttribute('data-no-router')) return null;
  if (link.getAttribute('rel')?.includes('external')) return null;

  let url;
  try {
    url = new URL(link.href, location.href);
  } catch {
    return null;
  }

  if (url.origin !== location.origin) return null;

  // A link to a different spot on the same page is the browser's job.
  if (url.pathname === location.pathname && url.hash) return null;

  return url;
}

function load(href) {
  if (cache.has(href)) return cache.get(href);

  const pending = fetch(href, { headers: { Accept: 'text/html' } })
    .then((response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.text();
    })
    .catch((error) => {
      // A failed prefetch must not poison the cache: the click that
      // follows should be able to try again, and fall back to a real
      // navigation if it fails too.
      cache.delete(href);
      throw error;
    });

  if (cache.size >= PREFETCH_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(href, pending);

  return pending;
}

async function go(href, { restore = false } = {}) {
  let html;

  try {
    html = await load(href);
  } catch {
    // Anything unexpected — a network failure, a 404, a redirect to
    // another origin — hands control back to the browser rather than
    // leaving the reader on a page that did not change.
    location.href = href;
    return;
  }

  // A second navigation may have started while this one was in
  // flight. Comparing against the address bar is enough to tell: it
  // already holds wherever the reader last asked to go.
  if (location.href !== href) return;

  const next = new DOMParser().parseFromString(html, 'text/html');
  const incoming = next.querySelector(ROOT);
  const target = document.querySelector(ROOT);

  if (!incoming || !target) {
    location.href = href;
    return;
  }

  document.title = next.title;
  syncHead(next);
  target.replaceWith(incoming.cloneNode(true));

  await runPageModule(next, href);

  currentUrl = href;
  restoreScroll(restore);
}

// Brings across anything in the new page's head that this one lacks —
// its description, its canonical link — and drops what it no longer
// needs. Stylesheets are left in place: they are shared across pages,
// and removing one mid-navigation causes a visible flash.
function syncHead(next) {
  const selector = 'meta[name], link[rel="canonical"]';
  const keep = new Set();

  for (const node of next.head.querySelectorAll(selector)) {
    const key = node.outerHTML;
    keep.add(key);

    const existing = [...document.head.querySelectorAll(selector)].find(
      (candidate) => candidate.outerHTML === key
    );
    if (!existing) document.head.append(node.cloneNode(true));
  }

  for (const node of document.head.querySelectorAll(selector)) {
    if (!keep.has(node.outerHTML)) node.remove();
  }
}

// Each page ships its own module of bindings. Importing it runs its
// hydration, which is what makes the newly inserted markup live.
//
// `pageHref` matters: a page's module is referenced relatively, and
// resolving that against the address bar is wrong. Every route is a
// directory, so "/about" and "/about/" resolve "./page.client.js"
// differently — the first lands on the *root* page's module, which
// then hydrates the page you just navigated away from back into place.
async function runPageModule(next, pageHref) {
  const script = next.querySelector('script[type="module"][src]');
  if (!script) return;

  const base = pageHref.endsWith('/') ? pageHref : `${pageHref}/`;
  const url = new URL(script.getAttribute('src'), base).href;

  try {
    // The cache-busting parameter matters: a module is evaluated once
    // per URL, so returning to a page would otherwise insert markup
    // that nothing ever binds to.
    await import(/* @vite-ignore */ `${url}${url.includes('?') ? '&' : '?'}azox=${Date.now()}`);
  } catch {
    // A page whose bindings fail still shows its server-rendered
    // markup, which is better than replacing it with nothing.
  }
}

function restoreScroll(restore) {
  if (restore) return; // The browser restores the position itself.

  const { hash } = location;
  const target = hash && document.querySelector(hash);

  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
}

export function currentHref() {
  return currentUrl;
}
