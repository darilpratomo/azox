// Types for `azoxjs/reactivity`.
//
// Written by hand rather than generated: the runtime carries no JSDoc,
// so `tsc --declaration` produces `signal(initialValue: any)`, which
// type-checks nothing. These describe what the implementation actually
// guarantees.

/**
 * A reactive value. Call it to read — and, inside an `effect`, to
 * subscribe to it.
 */
export interface Signal<T> {
  (): T;

  /**
   * Replaces the value, or derives it from the current one.
   *
   * Setting a value equal to the current one (`===`) notifies nobody.
   *
   * A function is treated as an updater, so a signal *holding* a
   * function cannot be replaced by passing it directly — pass
   * `() => theFunction` instead.
   */
  set(next: T | ((previous: T) => T)): void;

  /** Reads without subscribing, even inside an effect. */
  peek(): T;
}

/** A read-only reactive value. `computed` returns one of these. */
export interface ReadonlySignal<T> {
  (): T;
  peek(): T;
}

/**
 * The handle `effect` returns. Its only public use is `dispose`; its
 * internals are not part of the API and may change.
 */
export interface EffectHandle {
  (): void;
}

/** Creates a reactive value. */
export declare function signal<T>(initialValue: T): Signal<T>;

/**
 * Runs `fn` now, and again whenever a signal it read changes.
 *
 * Effects created while another is running belong to it, and are
 * disposed with it. Use `untracked` to opt out of that ownership.
 */
export declare function effect(fn: () => void): EffectHandle;

/**
 * A value derived from other signals, recomputed when they change.
 *
 * Read-only by design. The runtime object does carry `set`, but the
 * deriving effect overwrites whatever you assign on its next run, so
 * it is not offered here.
 */
export declare function computed<T>(fn: () => T): ReadonlySignal<T>;

/**
 * Runs `fn` with no effect considered active, so anything it creates
 * is owned by nobody and survives the caller re-running.
 */
export declare function untracked<T>(fn: () => T): T;

/** Stops an effect and everything it created. Ignores null. */
export declare function dispose(handle: EffectHandle | null | undefined): void;

/**
 * Runs once the DOM this scope built is in the document.
 *
 * A function returned from `fn` becomes the scope's cleanup, so setup
 * and teardown can stay together.
 */
export declare function onMount(fn: () => void | (() => void)): void;

/**
 * Registers work to undo when the surrounding scope goes away: a row
 * leaving a keyed list, or a branch of an `<if>` no longer taken.
 *
 * Called outside any scope it does nothing, which is the case at the
 * top level of a page — nothing ever removes it.
 */
export declare function onCleanup(fn: () => void): void;

/** A cursor over server-rendered nodes, used by hydration. */
export interface AdoptCursor {
  /** The next node if it matches — a tag name, or null for text. */
  next(expect: string | null): Node | null;
  /** Removes anything the module did not claim. */
  done(): void;
}

/**
 * Walks a parent's existing children so hydration can bind to them
 * rather than replacing them. Returns a cursor that yields null on any
 * mismatch, at which point the caller creates the node instead.
 */
export declare function adopt(parent: Node | null): AdoptCursor;
