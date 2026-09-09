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
    if (activeEffect) subscribers.add(activeEffect);
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
    const previous = activeEffect;
    activeEffect = wrapped;
    try {
      fn();
    } finally {
      activeEffect = previous;
    }
  };
  wrapped();
  return wrapped;
}

export function computed(fn) {
  const derived = signal(undefined);
  effect(() => derived.set(fn()));
  return derived;
}
