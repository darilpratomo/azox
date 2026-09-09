// The playground: compiles .azox source in the browser using the same
// compiler the CLI uses, then runs the result in a sandboxed iframe.

import {
  parseAzox,
  resolveComponents,
  compileToModule,
  renderToHtml,
  createMemoryResolver,
} from '/azox-compiler.js';

const PAGE_ID = '/index.azox';
const COMPONENT_ID = '/Card.azox';
const DEBOUNCE_MS = 300;

const STARTER = {
  page: `<script>
  import Card from './Card.azox';
  import { signal } from 'azox/reactivity';

  const count = signal(0);
  const name = signal('world');
</script>

<main>
  <h1>Hello, {name()}</h1>

  <Card label="Clicks" value={count()} />

  <button on:click={() => count.set(count() + 1)}>
    Add one
  </button>

  <input
    value={name()}
    on:input={(e) => name.set(e.target.value)}
  />
</main>`,

  component: `<script>
  const { label, value } = props();
</script>

<p class="card">{label}: {value}</p>`,
};

// Styles for the preview document. Kept minimal so what you see is
// mostly your own markup.
const PREVIEW_STYLES = `
  body {
    font: 15px/1.6 ui-sans-serif, system-ui, sans-serif;
    margin: 0;
    padding: 1.5rem;
    color: #16161f;
  }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  button, input {
    font: inherit;
    padding: 0.5rem 0.9rem;
    border-radius: 8px;
    border: 1px solid #d0d0dd;
    background: #fff;
    margin-right: 0.5rem;
  }
  button { cursor: pointer; background: #16161f; color: #fff; border-color: #16161f; }
  .card {
    background: #f4f4f8;
    border: 1px solid #e2e2ee;
    border-radius: 10px;
    padding: 0.9rem 1.1rem;
  }
`;

// Azox hydrates by clearing its root and rebuilding it, so any node
// captured before that runs is detached and dead. Wait for the
// rebuilt DOM before looking anything up.
async function waitForHydration() {
  const isReady = () => document.querySelector('[data-editor="page"]');

  if (isReady() && document.readyState === 'complete') {
    // One more frame, in case hydration is still queued.
    await new Promise((done) => requestAnimationFrame(done));
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    if (isReady()) return;
    await new Promise((done) => setTimeout(done, 20));
  }

  throw new Error('playground: the editors never appeared');
}

await waitForHydration();

const els = {
  page: document.querySelector('[data-editor="page"]'),
  component: document.querySelector('[data-editor="component"]'),
  preview: document.querySelector('[data-preview]'),
  error: document.querySelector('[data-error]'),
  output: document.querySelector('[data-output]'),
  tabs: document.querySelectorAll('[data-tab]'),
  panes: document.querySelectorAll('[data-pane]'),
};

// The runtime is fetched once and inlined into the preview document,
// so the iframe needs no network access of its own.
let runtimeSource = null;

async function loadRuntime() {
  if (runtimeSource === null) {
    const response = await fetch('/azox-runtime.js');
    runtimeSource = await response.text();
  }
  return runtimeSource;
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function clearError() {
  els.error.hidden = true;
}

async function compile() {
  const files = { [COMPONENT_ID]: els.component.value };
  const resolver = createMemoryResolver(files);

  let ast;
  try {
    ast = resolveComponents(parseAzox(els.page.value), PAGE_ID, resolver);
  } catch (error) {
    showError(error.message);
    return;
  }

  // Server render first, so a broken expression is reported before
  // anything is handed to the iframe.
  let html;
  try {
    html = renderToHtml(ast, buildScope(els.page.value));
  } catch (error) {
    showError(error.message);
    return;
  }

  let clientModule;
  try {
    clientModule = compileToModule(ast, { runtimeSpecifier: './azox-runtime.js' }).replace(
      /(['"])azox(?:\/reactivity)?\1/g,
      "'./azox-runtime.js'"
    );
  } catch (error) {
    showError(error.message);
    return;
  }

  clearError();
  els.output.textContent = clientModule;
  renderPreview(html, clientModule, await loadRuntime());
}

// Mirrors what the build does for server rendering: run the page's
// script with a non-reactive signal stub to get initial values.
function buildScope(source) {
  const match = source.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) return {};

  const body = match[1].replace(/^\s*import\s.+?;?\s*$/gm, '');
  const names = [...body.matchAll(/const\s+(\w+)\s*=/g)].map((m) => m[1]);

  const signal = (initial) => {
    let value = initial;
    const read = () => value;
    read.set = (next) => {
      value = typeof next === 'function' ? next(value) : next;
    };
    read.peek = () => value;
    return read;
  };

  try {
    return new Function('signal', `${body}\nreturn { ${names.join(', ')} };`)(signal);
  } catch (error) {
    throw new Error(`in <script>: ${error.message}`);
  }
}

function renderPreview(html, clientModule, runtime) {
  // Blob URLs give the iframe a real origin, which module scripts
  // need — a srcdoc document cannot import one.
  const runtimeUrl = URL.createObjectURL(new Blob([runtime], { type: 'text/javascript' }));

  const moduleSource = clientModule.replace("'./azox-runtime.js'", JSON.stringify(runtimeUrl));
  const moduleUrl = URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' }));

  const document_ = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>${PREVIEW_STYLES}</style>
</head>
<body>
<div data-azox-root>${html}</div>
<script type="module" src="${moduleUrl}"></script>
</body>
</html>`;

  const pageUrl = URL.createObjectURL(new Blob([document_], { type: 'text/html' }));
  const previous = els.preview.dataset.blobUrl;

  els.preview.src = pageUrl;
  els.preview.dataset.blobUrl = pageUrl;

  // Release the previous document once the new one has loaded.
  if (previous) setTimeout(() => URL.revokeObjectURL(previous), 1000);
}

let timer;
function scheduleCompile() {
  clearTimeout(timer);
  timer = setTimeout(compile, DEBOUNCE_MS);
}

for (const editor of [els.page, els.component]) {
  editor.addEventListener('input', scheduleCompile);

  // Tab should indent, not move focus out of the editor.
  editor.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();

    const { selectionStart, selectionEnd, value } = editor;
    editor.value = value.slice(0, selectionStart) + '  ' + value.slice(selectionEnd);
    editor.selectionStart = editor.selectionEnd = selectionStart + 2;
    scheduleCompile();
  });
}

for (const tab of els.tabs) {
  tab.addEventListener('click', () => {
    const wanted = tab.dataset.tab;

    for (const other of els.tabs) other.dataset.active = String(other.dataset.tab === wanted);
    for (const pane of els.panes) pane.hidden = pane.dataset.pane !== wanted;
  });
}

document.querySelector('[data-reset]')?.addEventListener('click', () => {
  els.page.value = STARTER.page;
  els.component.value = STARTER.component;
  compile();
});

els.page.value = STARTER.page;
els.component.value = STARTER.component;
compile();
