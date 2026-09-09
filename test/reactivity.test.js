import { test } from 'node:test';
import assert from 'node:assert/strict';

import { signal, effect, computed } from '../core/reactivity/signal.js';

test('signal returns its initial value', () => {
  const count = signal(5);
  assert.equal(count(), 5);
});

test('set updates the value', () => {
  const count = signal(0);
  count.set(3);
  assert.equal(count(), 3);
});

test('set accepts an updater function', () => {
  const count = signal(10);
  count.set((n) => n + 5);
  assert.equal(count(), 15);
});

test('peek reads without subscribing', () => {
  const count = signal(1);
  let runs = 0;

  effect(() => {
    runs++;
    count.peek();
  });

  count.set(2);
  assert.equal(runs, 1, 'peek must not create a dependency');
});

test('effect runs once immediately', () => {
  let runs = 0;
  effect(() => {
    runs++;
  });
  assert.equal(runs, 1);
});

test('effect re-runs when a read signal changes', () => {
  const count = signal(0);
  const seen = [];

  effect(() => seen.push(count()));
  count.set(1);
  count.set(2);

  assert.deepEqual(seen, [0, 1, 2]);
});

test('setting the same value does not re-run effects', () => {
  const count = signal(0);
  let runs = 0;

  effect(() => {
    count();
    runs++;
  });

  count.set(0);
  assert.equal(runs, 1, 'an unchanged value should not notify');
});

test('an effect only subscribes to signals it actually reads', () => {
  const a = signal(0);
  const b = signal(0);
  let runs = 0;

  effect(() => {
    a();
    runs++;
  });

  b.set(1);
  assert.equal(runs, 1, 'unrelated signal must not trigger the effect');
});

test('multiple effects on one signal all re-run', () => {
  const count = signal(0);
  let first = 0;
  let second = 0;

  effect(() => {
    count();
    first++;
  });
  effect(() => {
    count();
    second++;
  });

  count.set(1);
  assert.equal(first, 2);
  assert.equal(second, 2);
});

test('computed derives from a signal and tracks updates', () => {
  const count = signal(2);
  const doubled = computed(() => count() * 2);

  assert.equal(doubled(), 4);
  count.set(5);
  assert.equal(doubled(), 10);
});

test('nested effects do not leak their tracking context', () => {
  const outer = signal(0);
  const inner = signal(0);
  let outerRuns = 0;

  effect(() => {
    outer();
    outerRuns++;
    effect(() => {
      inner();
    });
  });

  const runsBefore = outerRuns;
  inner.set(1);

  assert.equal(
    outerRuns,
    runsBefore,
    'changing a signal read only by the inner effect must not re-run the outer one'
  );
});
