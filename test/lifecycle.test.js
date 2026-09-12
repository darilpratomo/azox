import { test } from 'node:test';
import assert from 'node:assert/strict';

import { signal, effect, computed, dispose, untracked, onMount, onCleanup } from '../core/reactivity/signal.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// onCleanup registers work to undo when the surrounding scope goes
// away; onMount runs once the DOM the scope builds is in place.

test('onCleanup runs when its scope is disposed', () => {
  const log = [];
  const scope = effect(() => {
    onCleanup(() => log.push('gone'));
  });

  assert.deepEqual(log, [], 'nothing runs while the scope is alive');

  dispose(scope);
  assert.deepEqual(log, ['gone']);
});

test('onCleanup runs before an effect re-runs', () => {
  const log = [];
  const value = signal(1);

  effect(() => {
    const current = value();
    onCleanup(() => log.push(`cleanup:${current}`));
  });

  value.set(2);
  assert.deepEqual(log, ['cleanup:1'], 'the previous run is undone before the next');
});

test('several cleanups all run', () => {
  const log = [];
  const scope = effect(() => {
    onCleanup(() => log.push('a'));
    onCleanup(() => log.push('b'));
  });

  dispose(scope);
  assert.deepEqual(log.sort(), ['a', 'b']);
});

// A cleanup that throws is a bug in the callback. It must not stop the
// others, or a half-cleaned scope leaks whatever they held.
test('one cleanup throwing does not stop the rest', () => {
  const log = [];
  const original = console.error;
  console.error = () => {};

  try {
    const scope = effect(() => {
      onCleanup(() => {
        throw new Error('boom');
      });
      onCleanup(() => log.push('still ran'));
    });

    dispose(scope);
    assert.deepEqual(log, ['still ran']);
  } finally {
    console.error = original;
  }
});

test('a cleanup in a nested scope runs when the parent is disposed', () => {
  const log = [];

  const parent = effect(() => {
    effect(() => {
      onCleanup(() => log.push('child'));
    });
  });

  dispose(parent);
  assert.deepEqual(log, ['child']);
});

test('onCleanup outside any scope is ignored rather than throwing', () => {
  assert.doesNotThrow(() => onCleanup(() => {}));
});

test('onCleanup rejects a non-function', () => {
  assert.throws(() => onCleanup('nope'), /needs a function/);
});

test('onMount runs after the synchronous render', async () => {
  const log = [];

  effect(() => {
    onMount(() => log.push('mounted'));
    log.push('rendered');
  });

  assert.deepEqual(log, ['rendered'], 'mount waits until the DOM exists');

  await tick();
  assert.deepEqual(log, ['rendered', 'mounted']);
});

test('a function returned from onMount becomes its cleanup', async () => {
  const log = [];

  const scope = effect(() => {
    onMount(() => {
      log.push('up');
      return () => log.push('down');
    });
  });

  await tick();
  assert.deepEqual(log, ['up']);

  dispose(scope);
  assert.deepEqual(log, ['up', 'down']);
});

// A row added and removed in the same tick must not run its setup —
// whatever it creates would never be cleaned up.
test('onMount does not run if the scope is disposed first', async () => {
  const log = [];

  const scope = effect(() => {
    onMount(() => log.push('should not run'));
  });

  dispose(scope);
  await tick();

  assert.deepEqual(log, []);
});

test('onMount rejects a non-function', () => {
  assert.throws(() => onMount('nope'), /needs a function/);
});

/* ---------- untracked ---------- */

// Regression, and the reason untracked exists: a keyed list builds its
// rows inside its own effect, which made each row a child of the list.
// Re-running the list then tore down every surviving row — its bindings
// stopped updating and its onCleanup callbacks fired, while the row was
// still on screen.
test('an effect created inside untracked survives its creator re-running', () => {
  const list = signal([1, 2]);
  const inner = signal('x');
  const rows = new Map();
  const runs = [];

  effect(() => {
    for (const id of list()) {
      if (!rows.has(id)) {
        rows.set(
          id,
          untracked(() =>
            effect(() => {
              inner();
              runs.push(id);
            })
          )
        );
      }
    }
  });

  list.set([1]);
  runs.length = 0;
  inner.set('y');

  assert.deepEqual(runs.sort(), [1, 2], 'rows keep their own subscriptions');
});

test('without untracked a nested effect is torn down by its creator', () => {
  const outer = signal(1);
  const inner = signal('x');
  const runs = [];
  let created = false;

  effect(() => {
    outer();
    if (created) return;
    created = true;
    effect(() => {
      inner();
      runs.push('inner');
    });
  });

  outer.set(2);
  runs.length = 0;
  inner.set('y');

  // Documents the behaviour untracked exists to opt out of: ownership
  // is what lets a control-flow block dispose content it replaces.
  assert.deepEqual(runs, [], 'an owned effect is disposed when its parent re-runs');
});

test('untracked returns what its callback returns', () => {
  assert.equal(
    untracked(() => 42),
    42
  );
});

test('untracked restores the previous active effect', () => {
  const value = signal(1);
  const runs = [];

  effect(() => {
    untracked(() => {});
    // Still tracked after untracked returns.
    value();
    runs.push('ran');
  });

  value.set(2);
  assert.equal(runs.length, 2, 'tracking resumes after untracked');
});

test('a cleanup registered in a disposed scope still runs once', async () => {
  const log = [];

  const scope = effect(() => {
    onMount(() => () => log.push('cleanup'));
  });

  await tick();
  dispose(scope);

  assert.deepEqual(log, ['cleanup']);
});

test('computed still works alongside the new hooks', () => {
  const n = signal(2);
  const doubled = computed(() => n() * 2);

  assert.equal(doubled(), 4);
  n.set(3);
  assert.equal(doubled(), 6);
});
