// Server-side renderer. Walks the same AST the compiler uses, but
// evaluates dynamic expressions once (synchronously) to produce a
// plain HTML string — no browser DOM APIs involved, so this runs
// directly in Node. The client script (emitted by compileToJs) then
// takes over in the browser and wires up live signal bindings on
// top of this markup.

import { BuildError } from '../buildError.js';
import { VOID_TAGS, escapeHtml } from '../compiler/html.js';

export function renderToHtml(ast, scope) {
  return renderNode(ast.markup, scope);
}

function renderNode(node, scope) {
  if (!node) return '';

  // A fragment (from <slot />) contributes only its children.
  if (node.type === 'fragment') {
    return node.children.map((child) => renderNode(child, scope)).join('');
  }

  if (node.type === 'text') {
    return node.parts.map((part) => renderTextPart(part, scope)).join('');
  }

  // Control flow is evaluated once here, so the page arrives with its
  // list already rendered rather than filling in when scripts run.
  if (node.type === 'each') return renderEach(node, scope);
  if (node.type === 'if') return renderIf(node, scope);
  if (node.type === 'scope') return renderScope(node, scope);

  const attrs = Object.entries(node.attrs)
    .filter(([key]) => !key.startsWith('on:'))
    .map(([key, attr]) => {
      const value = attr.kind === 'static' ? attr.value : String(evalExpr(attr.expr, scope));
      return ` ${key}="${escapeHtml(value)}"`;
    })
    .join('');

  if (VOID_TAGS.has(node.name)) return `<${node.name}${attrs}>`;

  const inner = node.children.map((child) => renderNode(child, scope)).join('');
  return `<${node.name}${attrs}>${inner}</${node.name}>`;
}

// A stateful component runs its script here too, with the caller's
// prop values bound as arguments, so the server sees the same initial
// state the browser will build. Its declarations are added to a copy
// of the scope, so they cannot leak into the surrounding page.
function renderScope(node, scope) {
  const args = node.args.map((expr) => evalExpr(expr, scope));

  let declared;
  try {
    const names = declaredNames(node.script);
    const fn = new Function(
      'signal',
      'computed',
      ...node.params,
      `${node.script}\nreturn { ${names.join(', ')} };`
    );
    declared = fn(serverSignal, serverComputed, ...args);
  } catch (error) {
    throw new BuildError(`in <${node.name}>: ${error.message}`);
  }

  const inner = { ...scope, ...declared };
  for (const [i, param] of node.params.entries()) inner[param] = args[i];

  return node.children.map((child) => renderNode(child, inner)).join('');
}

function declaredNames(script) {
  return [...script.matchAll(/(?:const|let|var)\s+(\w+)\s*=/g)].map((match) => match[1]);
}

// Server rendering needs only the current value, so a signal here is
// a plain box. The real reactive runtime takes over in the browser.
function serverSignal(initial) {
  let value = initial;
  const read = () => value;
  read.set = (next) => {
    value = typeof next === 'function' ? next(value) : next;
  };
  read.peek = () => value;
  return read;
}

function serverComputed(fn) {
  return () => fn();
}

// Each iteration renders with the loop variable added to the scope,
// so the body sees it the same way the compiled version does.
function renderEach(node, scope) {
  const items = evalExpr(node.expr, scope);
  if (!items) return '';

  let html = '';
  let index = 0;

  for (const item of items) {
    const inner = { ...scope, [node.alias]: item };
    if (node.index) inner[node.index] = index;

    html += node.children.map((child) => renderNode(child, inner)).join('');
    index++;
  }

  return html;
}

function renderIf(node, scope) {
  const branch = evalExpr(node.expr, scope) ? node.then : node.otherwise;
  return branch.map((child) => renderNode(child, scope)).join('');
}

// Three kinds of text, three rules:
//   static  — markup the author wrote, so an entity they typed
//             (&lt;) is meant to stay an entity. Passed through.
//   literal — content of a <text> block, meant to appear exactly as
//             written, so it is escaped into entities.
//   expr    — data, which is where untrusted content could enter.
//             Always escaped.
function renderTextPart(part, scope) {
  if (part.kind === 'static') return part.value;
  if (part.kind === 'literal') return escapeHtml(part.value);
  return escapeHtml(String(evalExpr(part.expr, scope)));
}

function evalExpr(expr, scope) {
  const keys = Object.keys(scope);

  let fn;
  try {
    fn = new Function(...keys, `return (${expr});`);
  } catch (error) {
    throw new BuildError(`{${expr}} is not valid JavaScript: ${error.message}`);
  }

  try {
    return fn(...keys.map((key) => scope[key]));
  } catch (error) {
    throw new BuildError(`{${expr}} failed while rendering: ${error.message}`);
  }
}

