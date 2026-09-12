// Public entry point for `import ... from 'azoxjs'`.

// The whole reactivity surface, so `azoxjs` and `azoxjs/reactivity`
// offer the same thing rather than the main entry quietly omitting the
// newer half.
export {
  signal,
  effect,
  computed,
  dispose,
  untracked,
  onMount,
  onCleanup,
} from './reactivity/signal.js';
export { parseAzox } from './compiler/parser.js';
export { compileToModule } from './compiler/compileToJs.js';
export { renderToHtml } from './renderer/renderToHtml.js';
export { VERSION, TAGLINE } from './meta.js';
