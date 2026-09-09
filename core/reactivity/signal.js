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

  wrapped();
  return wrapped;
}

// Detaches an effect from every signal it read, and disposes anything
// it created. Called before a re-run and by dispose().
function unsubscribe(effectFn) {
  for (const child of effectFn.children) unsubscribe(child);
  effectFn.children.clear();

  for (const subscribers of effectFn.sources) subscribers.delete(effectFn);
  effectFn.sources.clear();
}

// Stops an effect permanently. Control-flow blocks use this to clean
// up the effects belonging to content they are about to remove;
// without it, every list item ever rendered would stay subscribed.
export function dispose(effectFn) {
  if (effectFn) unsubscribe(effectFn);
}

export function computed(fn) {
  const derived = signal(undefined);
  effect(() => derived.set(fn()));
  return derived;
}
