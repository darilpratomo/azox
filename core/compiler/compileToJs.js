// Turns a parsed .azox AST into a JS module. The generated `render`
// function builds real DOM nodes and wires each dynamic binding to
// its own effect — no Virtual DOM tree, no diffing. A signal update
// touches exactly the text node or attribute it owns.

import { relative, dirname, resolve } from 'node:path';

let uid = 0;
const nextId = () => `_el${uid++}`;

// sourcePath: absolute path of the .azox file being compiled.
// outPath: absolute path of the client module being written.
// runtimeSpecifier: how the emitted module should import the Azox
//   runtime — a bare "azox/reactivity" for user projects, or a
//   relative path when compiling inside the framework itself.
//
// Relative import specifiers in the user's <script> are resolved
// against sourcePath and re-expressed relative to outPath, since
// compiled output lives in .azox/build/, not next to the page.
// Bare specifiers are left untouched for the resolver to handle.
export function compileToModule(ast, { sourcePath, outPath, runtimeSpecifier }) {
  uid = 0;
  const statements = [];
  const rootVar = emitNode(ast.markup, statements, 'root');
  const script = rebaseImports(dropComponentImports(ast.script), dirname(sourcePath), outPath);

  return `
import { effect } from '${runtimeSpecifier}';
${script}

export function render(mount) {
${statements.map((line) => '  ' + line).join('\n')}
  mount.appendChild(${rootVar});
  return ${rootVar};
}

// Hydrate: the SSR markup is already on the page, so clear it and
// mount the reactive version in its place.
if (typeof document !== 'undefined') {
  const mount = document.querySelector('[data-azox-root]') ?? document.body;
  mount.innerHTML = '';
  render(mount);
}
`.trimStart();
}

function emitNode(node, statements, fallbackVar) {
  if (!node) return 'null';

  if (node.type === 'text') {
    return emitText(node, statements, fallbackVar);
  }

  // A fragment (from <slot />) has no element of its own; it wraps
  // its children in a DocumentFragment so they land in the parent.
  if (node.type === 'fragment') {
    const varName = nextId();
    statements.push(`const ${varName} = document.createDocumentFragment();`);
    appendChildren(varName, node.children, statements, fallbackVar);
    return varName;
  }

  const varName = nextId();
  statements.push(`const ${varName} = document.createElement(${JSON.stringify(node.name)});`);

  for (const [key, attr] of Object.entries(node.attrs)) {
    emitAttr(varName, key, attr, statements);
  }

  appendChildren(varName, node.children, statements, fallbackVar);

  return varName;
}

function appendChildren(parentVar, children, statements, fallbackVar) {
  for (const child of children) {
    const childVar = emitNode(child, statements, fallbackVar);
    if (childVar !== 'null') statements.push(`${parentVar}.appendChild(${childVar});`);
  }
}

function emitText(node, statements, fallbackVar) {
  // Purely static text: one text node, no effect needed.
  if (node.parts.every((p) => p.kind === 'static')) {
    const value = node.parts.map((p) => p.value).join('');
    const varName = nextId();
    statements.push(`const ${varName} = document.createTextNode(${JSON.stringify(value)});`);
    return varName;
  }

  // Dynamic text: one text node, one effect that rewrites its data.
  const varName = nextId();
  statements.push(`const ${varName} = document.createTextNode('');`);
  const expr = node.parts
    .map((p) => (p.kind === 'static' ? JSON.stringify(p.value) : `String(${p.expr})`))
    .join(' + ');
  statements.push(`effect(() => { ${varName}.data = ${expr}; });`);
  return varName;
}

function emitAttr(varName, key, attr, statements) {
  if (key.startsWith('on:')) {
    const event = key.slice(3);
    statements.push(`${varName}.addEventListener(${JSON.stringify(event)}, ${attr.expr});`);
    return;
  }

  if (attr.kind === 'static') {
    statements.push(`${varName}.setAttribute(${JSON.stringify(key)}, ${JSON.stringify(attr.value)});`);
    return;
  }

  // Dynamic attribute: wrap in its own effect, same fine-grained rule as text.
  statements.push(`effect(() => { ${varName}.setAttribute(${JSON.stringify(key)}, String(${attr.expr})); });`);
}

// Component imports are resolved at build time and inlined, so the
// .azox specifier must not survive into JavaScript the browser loads.
function dropComponentImports(script) {
  return script.replace(/^\s*import\s+[A-Z]\w*\s+from\s+['"][^'"]+\.azox['"]\s*;?\s*$/gm, '');
}

// Rewrites every relative import specifier in the user's <script>
// block so it still resolves once the module lives in outPath
// instead of next to sourceDir.
function rebaseImports(script, sourceDir, outPath) {
  return script.replace(
    /(from\s+|import\s+)(['"])(\.[^'"]*)\2/g,
    (full, keyword, quote, specifier) =>
      `${keyword}${quote}${rebaseSpecifier(resolve(sourceDir, specifier), outPath)}${quote}`
  );
}

// Re-expresses an absolute target path as a path relative to outPath.
function rebaseSpecifier(absoluteTarget, outPath) {
  let rebased = relative(dirname(outPath), absoluteTarget);
  if (!rebased.startsWith('.')) rebased = `./${rebased}`;
  return rebased;
}
