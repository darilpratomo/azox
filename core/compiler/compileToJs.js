// Turns a parsed .azox AST into a JS module. The generated `render`
// function builds real DOM nodes and wires each dynamic binding to
// its own effect — no Virtual DOM tree, no diffing. A signal update
// touches exactly the text node or attribute it owns.

// This module has no Node built-ins on purpose: it runs unchanged in
// the browser, which is what makes the playground possible. Anything
// that needs to know about paths on disk belongs in build.js.

let uid = 0;
const nextId = () => `_el${uid++}`;

// runtimeSpecifier: how the emitted module should import the Azox
//   runtime — a relative path to the copied runtime for a build, or
//   whatever the playground wants to point at.
// rewriteImports: optional hook the build uses to rebase the user's
//   own relative imports, since compiled output lives in
//   .azox/build/ rather than next to the page. The playground has no
//   output directory, so it omits this.
export function compileToModule(ast, { runtimeSpecifier, rewriteImports }) {
  uid = 0;
  const statements = [];
  const rootVar = emitNode(ast.markup, statements, 'root');

  let script = dropComponentImports(ast.script);
  if (rewriteImports) script = rewriteImports(script);

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

// createTextNode takes text, not markup, so an entity the author
// wrote in static markup has to be decoded here — otherwise the
// browser would show a literal "&lt;" where the server rendered "<",
// and the page would visibly change on hydration. Content from a
// <text> block is already literal and passes through untouched.
const textValue = (part) => (part.kind === 'literal' ? part.value : decodeEntities(part.value));

function emitText(node, statements, fallbackVar) {
  const isFixed = (part) => part.kind === 'static' || part.kind === 'literal';

  // Nothing dynamic: one text node, no effect needed.
  if (node.parts.every(isFixed)) {
    const value = node.parts.map(textValue).join('');
    const varName = nextId();
    statements.push(`const ${varName} = document.createTextNode(${JSON.stringify(value)});`);
    return varName;
  }

  // Dynamic text: one text node, one effect that rewrites its data.
  const varName = nextId();
  statements.push(`const ${varName} = document.createTextNode('');`);
  const expr = node.parts
    .map((part) => (isFixed(part) ? JSON.stringify(textValue(part)) : `String(${part.expr})`))
    .join(' + ');
  statements.push(`effect(() => { ${varName}.data = ${expr}; });`);
  return varName;
}

// The five entities that matter for text content. Numeric forms are
// handled too, since documentation snippets tend to use them.
function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
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

