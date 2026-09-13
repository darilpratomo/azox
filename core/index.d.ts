// Types for `azoxjs`.
//
// The whole reactivity surface, plus the compiler and renderer, so this
// entry point and `azoxjs/reactivity` offer the same thing.

export {
  signal,
  effect,
  computed,
  dispose,
  untracked,
  onMount,
  onCleanup,
  adopt,
  type Signal,
  type ReadonlySignal,
  type EffectHandle,
  type AdoptCursor,
} from './reactivity/signal.js';

export { parseAzox, compileToModule } from './compiler/index.js';

// Imported as well as re-exported: a type-only re-export names the type
// for consumers but does not put it in scope here, and renderToHtml
// below refers to it.
import type { AzoxAst } from './compiler/index.js';
export type { AzoxAst, CompileOptions } from './compiler/index.js';

/**
 * Renders a parsed file to HTML, evaluating its expressions once.
 *
 * `scope` holds the bindings the markup reads. `modules` carries what
 * the file's imports brought in, which the build resolves.
 */
export declare function renderToHtml(
  ast: AzoxAst,
  scope: Record<string, unknown>,
  modules?: Record<string, unknown>
): string;

/** The version this copy of Azox reports. */
export declare const VERSION: string;
export declare const TAGLINE: string;
