// Server-side renderer. Walks the same AST the compiler uses, but
// evaluates dynamic expressions once (synchronously) to produce a
// plain HTML string — no browser DOM APIs involved, so this runs
// directly in Node. The client script (emitted by compileToJs) then
// takes over in the browser and wires up live signal bindings on
// top of this markup.

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

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
    return node.parts
      .map((part) => (part.kind === 'static' ? escapeHtml(part.value) : escapeHtml(String(evalExpr(part.expr, scope)))))
      .join('');
  }

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

function evalExpr(expr, scope) {
  const keys = Object.keys(scope);
  const fn = new Function(...keys, `return (${expr});`);
  return fn(...keys.map((k) => scope[k]));
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
