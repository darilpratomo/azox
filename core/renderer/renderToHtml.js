// Server-side renderer. Walks the same AST the compiler uses, but
// evaluates dynamic expressions once (synchronously) to produce a
// plain HTML string — no browser DOM APIs involved, so this runs
// directly in Node. The client script (emitted by compileToJs) then
// takes over in the browser and wires up live signal bindings on
// top of this markup.

import { BuildError } from '../buildError.js';
import { VOID_TAGS, escapeHtml } from '../compiler/html.js';
import { evaluateScript } from './serverScope.js';

// `modules` is what the page's and its components' imports brought in,
// as local name → value. A component's script is evaluated here too,
// and its imports were hoisted to the page, so the bindings have to be
// handed down rather than re-resolved — this file has no filesystem
// access by design.
export function renderToHtml(ast, scope, modules = {}) {
  return renderNode(ast.markup, scope, scope, modules);
}

// `outer` is the scope the surrounding markup was written in. It is
// almost always the same as `scope`; they differ inside a component,
// where slot content belongs to whoever wrote the tag rather than to
// the component rendering it.
function renderNode(node, scope, outer, modules = {}) {
  if (!node) return '';

  // A fragment contributes only its children. Slot content is the one
  // place the two scopes come apart.
  if (node.type === 'fragment') {
    const childScope = node.slot ? outer : scope;
    return node.children.map((child) => renderNode(child, childScope, outer, modules)).join('');
  }

  if (node.type === 'text') {
    return node.parts.map((part) => renderTextPart(part, scope)).join('');
  }

  // Control flow is evaluated once here, so the page arrives with its
  // list already rendered rather than filling in when scripts run.
  if (node.type === 'each') return renderEach(node, scope, outer, modules);
  if (node.type === 'if') return renderIf(node, scope, outer, modules);
  if (node.type === 'scope') return renderScope(node, scope, modules);

  const attrs = Object.entries(node.attrs)
    .filter(([key]) => !key.startsWith('on:'))
    .map(([key, attr]) => {
      // bind:value={draft} renders as the plain attribute, so the input
      // arrives holding its value rather than showing "bind:value" in
      // the markup and filling in once scripts run.
      //
      // A binding names the signal rather than calling it — that is what
      // lets it write back — so it has to be read here.
      const bound = key.startsWith('bind:');
      const name = bound ? key.slice(5) : key;

      const raw = attr.kind === 'static'
        ? attr.value
        : readAttrValue(attr.expr, scope, bound);

      // A checkbox is checked by the attribute being present at all, so
      // a falsy value must omit it rather than render checked="false".
      if (name === 'checked' || name === 'selected') {
        return raw ? ` ${name}` : '';
      }

      return ` ${name}="${escapeHtml(String(raw ?? ''))}"`;
    })
    .join('');

  if (VOID_TAGS.has(node.name)) return `<${node.name}${attrs}>`;

  const inner = node.children.map((child) => renderNode(child, scope, outer, modules)).join('');
  return `<${node.name}${attrs}>${inner}</${node.name}>`;
}

// A stateful component runs its script here too, with the caller's
// prop values bound as arguments, so the server sees the same initial
// state the browser will build. Its declarations are added to a copy
// of the scope, so they cannot leak into the surrounding page.
function renderScope(node, scope, modules = {}) {
  const args = node.args.map((expr) => evalExpr(expr, scope));

  let declared;
  try {
    // A component's own imports were hoisted to the page and loaded
    // there, so they are passed in rather than resolved again.
    declared = evaluateScript(node.script, node.params, args, modules);
  } catch (error) {
    throw new BuildError(`in <${node.name}>: ${error.message}`);
  }

  const inner = { ...scope, ...declared };
  for (const [i, param] of node.params.entries()) inner[param] = args[i];

  // `scope` is passed on as the outer one: slot content nested in
  // this component was written by whoever used the tag.
  return node.children.map((child) => renderNode(child, inner, scope, modules)).join('');
}

// Each iteration renders with the loop variable added to the scope,
// so the body sees it the same way the compiled version does.
function renderEach(node, scope, outer, modules = {}) {
  const items = evalExpr(node.expr, scope);
  if (items === null || items === undefined) return wrapBlock('');

  if (typeof items[Symbol.iterator] !== 'function') {
    throw new BuildError(
      `<each item={${node.expr}}> needs something iterable, such as an array — got ${typeof items}`
    );
  }

  let html = '';
  let index = 0;

  for (const item of items) {
    const inner = { ...scope, [node.alias]: item };
    if (node.index) inner[node.index] = index;

    html += node.children.map((child) => renderNode(child, inner, outer, modules)).join('');
    index++;
  }

  return wrapBlock(html);
}

function renderIf(node, scope, outer, modules = {}) {
  const branch = evalExpr(node.expr, scope) ? node.then : node.otherwise;
  const inner = branch.map((child) => renderNode(child, scope, outer, modules)).join('');

  return wrapBlock(inner);
}

// The same start/end pair the compiler builds, so hydration can adopt
// the server's nodes instead of discarding them. Labelled, because an
// empty comment cannot be told apart from its neighbour.
//
// See docs/hydration.md.
function wrapBlock(html) {
  return `<!--[-->${html}<!--]-->`;
}

// Reads an attribute expression. A bound one names a signal, so it is
// called; anything else is evaluated as written.
function readAttrValue(expr, scope, bound) {
  const value = evalExpr(expr, scope);
  return bound && typeof value === 'function' ? value() : value;
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

