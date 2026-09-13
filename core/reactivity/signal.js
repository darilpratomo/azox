// Azox's reactivity primitive. No Virtual DOM, no diffing tree —
// a signal tracks its own subscribers and notifies only them when
// its value changes. Effects that read a signal during their run
// are auto-subscribed; this is what lets compiled bindings update
// a single DOM node directly instead of re-rendering a component.

let activeEffect = null;

export function signal(initialValue) {
  let value = initialValue;
  const subscribers = new Set();

  function read() {
    if (activeEffect) {
      subscribers.add(activeEffect);
      // Remember the link from both ends, so disposing an effect can
      // remove it from every signal it read.
      activeEffect.sources.add(subscribers);
    }
    return value;
  }

  read.set = (next) => {
    const resolved = typeof next === 'function' ? next(value) : next;
    if (resolved === value) return;
    value = resolved;
    for (const effect of [...subscribers]) effect();
  };

  read.peek = () => value;

  return read;
}

// Runs `fn` with no effect considered active, so anything it creates
// belongs to nobody and survives the caller re-running.
//
// A keyed list needs this: its rows are built inside the list's own
// effect, which would make them its children — and re-running the list
// then tears down every surviving row, leaving it on screen but no
// longer reactive.
export function untracked(fn) {
  const previous = activeEffect;
  activeEffect = null;
  try {
    return fn();
  } finally {
    activeEffect = previous;
  }
}

export function effect(fn) {
  const wrapped = () => {
    // Drop last run's subscriptions before re-reading. Without this,
    // an effect stays subscribed to signals it no longer reads.
    unsubscribe(wrapped);

    const previous = activeEffect;
    activeEffect = wrapped;
    try {
      fn();
    } finally {
      activeEffect = previous;
    }
  };

  wrapped.sources = new Set();

  // Effects created while another effect runs — a control-flow block
  // rebuilding its body, say — belong to it, so they can be disposed
  // together when it re-runs.
  if (activeEffect) activeEffect.children.add(wrapped);
  wrapped.children = new Set();

  // Callbacks registered by onCleanup() while this effect runs.
  wrapped.cleanups = new Set();

  wrapped();
  return wrapped;
}

// Registers work to undo when the surrounding scope goes away: a
// timer to clear, a listener to remove, a subscription to close.
//
// Called inside a component's script it runs when the component is
// removed — a row leaving a keyed list, or a branch of an <if> that is
// no longer taken. Called at the top level of a page there is nothing
// that ever removes it, so it never runs; that is a page living as long
// as the document, not a failure.
export function onCleanup(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('onCleanup() needs a function to call when the scope goes away');
  }

  if (!activeEffect) return;
  activeEffect.cleanups.add(fn);
}

// Runs after the DOM this scope builds is in the document.
//
// A component's script runs while its nodes are still being created,
// so measuring an element or focusing an input has to wait. Queued as
// a microtask, which is after the synchronous render and before the
// browser paints.
export function onMount(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('onMount() needs a function to call once the DOM is ready');
  }

  // Captured now: by the time the microtask runs, the effect that owns
  // this registration is no longer the active one.
  const owner = activeEffect;

  queueMicrotask(() => {
    // The scope was disposed before it ever mounted — a row added and
    // removed in the same tick. Running setup for something already
    // gone would leak whatever it creates.
    if (owner && owner.disposed) return;

    const result = fn();

    // A function returned from onMount is treated as its cleanup, so
    // the common setup-and-teardown pair can stay in one place.
    if (typeof result === 'function') {
      if (owner && !owner.disposed) owner.cleanups.add(result);
      else result();
    }
  });
}

// Detaches an effect from every signal it read, and disposes anything
// it created. Called before a re-run and by dispose().
function unsubscribe(effectFn) {
  for (const child of effectFn.children) unsubscribe(child);
  effectFn.children.clear();

  // Cleanups run before the effect is detached, so they still see the
  // state they were registered against. One throwing must not stop the
  // rest — a half-cleaned scope leaks whatever the others held.
  for (const cleanup of effectFn.cleanups ?? []) {
    try {
      cleanup();
    } catch (error) {
      reportCleanupError(error);
    }
  }
  effectFn.cleanups?.clear();

  for (const subscribers of effectFn.sources) subscribers.delete(effectFn);
  effectFn.sources.clear();
}

// A cleanup that throws is a bug in the callback, not in the scope
// being torn down. Reported rather than swallowed, and rather than
// taking the rest of the teardown with it.
function reportCleanupError(error) {
  if (typeof console !== 'undefined') {
    console.error('Azox: an onCleanup callback threw', error);
  }
}

// Stops an effect permanently. Control-flow blocks use this to clean
// up the effects belonging to content they are about to remove;
// without it, every list item ever rendered would stay subscribed.
export function dispose(effectFn) {
  if (!effectFn) return;

  // Marked before the walk, so an onMount microtask that has not run
  // yet knows its scope is gone and skips its setup.
  markDisposed(effectFn);
  unsubscribe(effectFn);
}

function markDisposed(effectFn) {
  effectFn.disposed = true;
  for (const child of effectFn.children) markDisposed(child);
}

export function computed(fn) {
  const derived = signal(undefined);
  effect(() => derived.set(fn()));
  return derived;
}

/* ---------- hydration ---------- */

// A cursor over server-rendered nodes, so hydration can bind to what is
// already on the page instead of replacing it. Replacing destroys the
// reader's focus, caret and anything they had expanded.
//
// `next` returns the node the compiled module expected, or null when the
// markup does not match — a stale cache, an edited page, a host without
// a walkable DOM. The module then creates that node as it always did, so
// a mismatch costs the work we already do rather than a broken page.
export function adopt(parent) {
  // A minimal DOM stub — the compiler's own tests use one — has no
  // childNodes to walk. Creating is then the only option.
  if (!parent || typeof parent !== 'object' || !parent.firstChild) {
    return { next: () => null, done: () => {} };
  }

  // Snapshotted rather than walked through `nextSibling`. The caller
  // appends each node it adopts, and appending a node that is already a
  // child detaches and re-attaches it — which rewrites `nextSibling` for
  // whatever preceded it. A lazy walk therefore ends up pointing at a
  // node it already handed out, and the sweep below deletes the live
  // page. Measured: every child adopted in the right order, and every
  // one removed a moment later. The list is fixed before any of that can
  // happen, so reordering cannot move the cursor.
  const kids = [];
  for (let child = parent.firstChild; child; child = child.nextSibling) kids.push(child);
  let i = 0;

  return {
    // `expect` is a tag name for an element, or null for a text node.
    next(expect) {
      const current = kids[i];
      if (!current) return null;

      const isText = current.nodeType === 3;
      const matches = expect === null ? isText : !isText && current.nodeName?.toLowerCase() === expect;

      if (!matches) return null;

      i++;
      return current;
    },

    // Anything the server sent that the module did not claim is stale
    // and has to go, or it would linger below the adopted nodes.
    done() {
      for (; i < kids.length; i++) kids[i].remove?.();
    },
  };
}
