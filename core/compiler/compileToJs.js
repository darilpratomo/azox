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

  // A page with no bindings and no listeners has nothing to hydrate:
  // the server-rendered markup is already the finished page. Leaving
  // it alone avoids a pointless rebuild, and avoids destroying nodes
  // that other scripts on the page may be holding.
  const isStatic = !statements.some(
    (line) =>
      line.startsWith('effect(') ||
      line.startsWith('_blocks.push(') ||
      line.includes('.addEventListener(')
  );

  // Control-flow blocks need their markers to be in the document
  // before they can insert anything, so they are collected here and
  // started once the tree is mounted.
  const usesBlocks = statements.some((line) => line.startsWith('_blocks.push('));

  return `
import { effect } from '${runtimeSpecifier}';
${script}

export function render(mount) {
${usesBlocks ? '  const _blocks = [];\n' : ''}${statements.map((line) => '  ' + line).join('\n')}
  mount.appendChild(${rootVar});
${usesBlocks ? '  for (const _start of _blocks) _start();\n' : ''}  return ${rootVar};
}
${isStatic ? staticNote() : hydrateBlock()}`.trimStart();
}

function staticNote() {
  return `
// This page has no bindings and no listeners, so the server-rendered
// markup is already complete and is left untouched. render() is
// exported for anyone who wants to mount it somewhere else.
`;
}

function hydrateBlock() {
  return `
// Hydrate: the SSR markup is already on the page, so clear it and
// mount the reactive version in its place.
if (typeof document !== 'undefined') {
  const mount = document.querySelector('[data-azox-root]') ?? document.body;
  mount.innerHTML = '';
  render(mount);
}
`;
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

  if (node.type === 'each') return emitEach(node, statements);
  if (node.type === 'if') return emitIf(node, statements);

  const varName = nextId();
  statements.push(`const ${varName} = document.createElement(${JSON.stringify(node.name)});`);

  for (const [key, attr] of Object.entries(node.attrs)) {
    emitAttr(varName, key, attr, statements);
  }

  appendChildren(varName, node.children, statements, fallbackVar);

  return varName;
}

// Control flow needs a fixed point in the DOM to work from, since the
// nodes it manages come and go. An empty comment node serves as that
// anchor: it stays put, and everything the block renders is inserted
// before it and removed by walking back from it.
//
// Only the nodes between the markers are touched when the source
// signal changes — the rest of the page is never involved, which is
// the same guarantee a text binding gives.
function emitControlBlock(statements, buildBody, sourceExpr, renderCall) {
  const start = nextId();
  const end = nextId();
  const frag = nextId();

  statements.push(`const ${start} = document.createComment('');`);
  statements.push(`const ${end} = document.createComment('');`);

  // The body is compiled once into a function, then called as needed.
  const bodyLines = [];
  const bodyVar = buildBody(bodyLines);

  statements.push(`const ${frag} = (${bodyVar.params}) => {`);
  statements.push(`  const _frag = document.createDocumentFragment();`);
  for (const line of bodyLines) statements.push(`  ${line}`);
  for (const rootVar of bodyVar.roots) {
    statements.push(`  if (${rootVar} !== null) _frag.appendChild(${rootVar});`);
  }
  statements.push(`  return _frag;`);
  statements.push(`};`);

  // Deferred until the tree is mounted: the markers have no parent
  // while the page is still being assembled, and a block cannot
  // insert anything without one.
  statements.push(`_blocks.push(() => effect(() => {`);
  statements.push(`  // Read the source before anything can return early. An effect`);
  statements.push(`  // subscribes only to what it reads, so bailing out first would`);
  statements.push(`  // leave this block subscribed to nothing and never update.`);
  statements.push(`  const _source = ${sourceExpr};`);
  statements.push(``);
  statements.push(`  // Clearing walks back from the end marker, so nothing outside`);
  statements.push(`  // the block can be removed by accident.`);
  statements.push(`  while (${end}.previousSibling && ${end}.previousSibling !== ${start}) {`);
  statements.push(`    ${end}.previousSibling.remove();`);
  statements.push(`  }`);
  statements.push(``);
  statements.push(`  const _parent = ${end}.parentNode;`);
  statements.push(`  if (!_parent) return;`);
  for (const line of renderCall(frag, end)) statements.push(`  ${line}`);
  statements.push(`}));`);

  // Hand back a fragment holding both markers, so the caller appends
  // this the way it appends any other node.
  const holder = nextId();
  statements.push(`const ${holder} = document.createDocumentFragment();`);
  statements.push(`${holder}.append(${start}, ${end});`);

  return holder;
}

function emitEach(node, statements) {
  const params = node.index ? `${node.alias}, ${node.index}` : node.alias;

  return emitControlBlock(
    statements,
    (bodyLines) => {
      // Compile the body once; each iteration calls it with its own
      // item, so the DOM calls are shared rather than duplicated.
      const roots = node.children.map((child) => emitNode(child, bodyLines, 'root'));
      return { params, roots };
    },
    node.expr,
    (frag, endVar) => [
      `if (_source) {`,
      `  let _i = 0;`,
      `  for (const _item of _source) {`,
      `    _parent.insertBefore(${frag}(_item${node.index ? ', _i' : ''}), ${endVar});`,
      `    _i++;`,
      `  }`,
      `}`,
    ]
  );
}

function emitIf(node, statements) {
  return emitControlBlock(
    statements,
    (bodyLines) => {
      // Both branches are compiled into the same function, selected by
      // a flag, so a conditional costs one function rather than two.
      const thenLines = [];
      const thenRoots = node.then.map((child) => emitNode(child, thenLines, 'root'));

      const elseLines = [];
      const elseRoots = node.otherwise.map((child) => emitNode(child, elseLines, 'root'));

      bodyLines.push(`const _out = document.createDocumentFragment();`);
      bodyLines.push(`if (_branch) {`);
      for (const line of thenLines) bodyLines.push(`  ${line}`);
      for (const root of thenRoots) {
        if (root !== 'null') bodyLines.push(`  _out.appendChild(${root});`);
      }
      bodyLines.push(`} else {`);
      for (const line of elseLines) bodyLines.push(`  ${line}`);
      for (const root of elseRoots) {
        if (root !== 'null') bodyLines.push(`  _out.appendChild(${root});`);
      }
      bodyLines.push(`}`);

      return { params: '_branch', roots: ['_out'] };
    },
    node.expr,
    (frag, endVar) => [`_parent.insertBefore(${frag}(Boolean(_source)), ${endVar});`]
  );
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

// `{'{'}` is how a page writes a literal brace, since bare braces
// start an expression. It is a constant, so it should not produce an
// effect — a page whose only "dynamic" content is escaped punctuation
// would otherwise be treated as reactive and hydrated needlessly.
function foldLiteralParts(parts) {
  return parts.map((part) => {
    if (part.kind !== 'expr') return part;

    const match = part.expr.trim().match(/^'((?:[^'\\]|\\.)*)'$|^"((?:[^"\\]|\\.)*)"$/);
    if (!match) return part;

    const raw = match[1] ?? match[2];
    return { kind: 'literal', value: raw.replace(/\\(['"\\])/g, '$1') };
  });
}

function emitText(node, statements, fallbackVar) {
  const isFixed = (part) => part.kind === 'static' || part.kind === 'literal';
  node = { ...node, parts: foldLiteralParts(node.parts) };

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

