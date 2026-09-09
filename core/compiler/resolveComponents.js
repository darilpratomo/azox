// Resolves <Component /> usage at build time by inlining each
// component's markup into its caller.
//
// Nothing survives into the runtime: there is no component instance,
// no lifecycle, no reconciliation. A component is a compile-time unit
// of reuse, so the emitted code looks the same as if the markup had
// been written by hand.

import { parseAzox } from './parser.js';
import { BuildError } from '../buildError.js';

// Extends BuildError so the CLI reports it as a user-facing problem
// rather than an internal crash with a stack trace.
export class ComponentError extends BuildError {}

// Returns the AST with every component reference replaced by that
// component's markup. The caller's script is untouched: components
// contribute markup only.
//
// `resolver` decides how an import specifier becomes source text, so
// this runs unchanged against disk or against an in-memory map. See
// sourceResolver.js.
export function resolveComponents(ast, sourcePath, resolver, seen = new Set()) {
  return { ...ast, markup: expand(ast.markup, ast, sourcePath, resolver, seen) };
}

function expand(node, ast, sourcePath, resolver, seen) {
  if (!node || node.type === 'text') return node;

  const children = (node.children ?? []).map((child) =>
    expand(child, ast, sourcePath, resolver, seen)
  );

  if (node.type !== 'component') {
    return { ...node, children };
  }

  const component = loadComponent(node.name, ast, sourcePath, resolver, seen);
  validateProps(node, component);
  validateNoLocalState(node.name, component);

  // The component's own body may reference further components, so
  // expand it against its own imports and its own location.
  const inner = resolveComponents(
    component.ast,
    component.path,
    resolver,
    new Set([...seen, component.path])
  );

  return substituteProps(inner.markup, propValues(node, component.ast.props), children);
}

function loadComponent(name, ast, sourcePath, resolver, seen) {
  const specifier = ast.components[name];

  if (!specifier) {
    throw new ComponentError(
      `<${name}> is used but never imported. Add: import ${name} from './components/${name}.azox';`
    );
  }

  const path = resolver.resolve(specifier, sourcePath);

  if (seen.has(path)) {
    throw new ComponentError(`component cycle detected: ${name} eventually renders itself`);
  }

  const source = resolver.read(path);

  if (source === null) {
    throw new ComponentError(`<${name}> points at ${specifier}, which does not exist`);
  }

  return { path, ast: parseAzox(source) };
}

// Components are presentational in this version: they take props and
// render markup. Because a component is inlined into its caller,
// state declared inside one would share the caller's scope and could
// collide with it — so it is rejected outright rather than producing
// a subtle bug. Lifting the restriction needs per-component scoping,
// which is a deliberate design step, not an accident.
function validateNoLocalState(name, component) {
  const script = component.ast.script;
  if (!script) return;

  // Comments are documentation, not logic, so they are stripped
  // before deciding whether a component declares anything.
  const remaining = script
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import\s.+?;?\s*$/gm, '')
    .replace(/const\s*\{[^}]*\}\s*=\s*props\(\)\s*;?/, '');

  if (remaining.trim()) {
    throw new ComponentError(
      `<${name}> declares logic beyond props(), which this version does not support. ` +
        'Components take props and render markup; keep state in the page that uses them.'
    );
  }
}

// A caller passing something the component never declared is almost
// always a typo, and silently dropping it hides the mistake.
function validateProps(node, component) {
  const declared = new Set(component.ast.props);

  for (const attr of Object.keys(node.attrs)) {
    if (attr.startsWith('on:')) continue;

    if (!declared.has(attr)) {
      const known = component.ast.props.length
        ? `It accepts: ${component.ast.props.join(', ')}.`
        : 'It declares no props.';
      throw new ComponentError(`<${node.name}> was given "${attr}", which it does not declare. ${known}`);
    }
  }
}

// Maps each declared prop to the expression the caller supplied.
// A static attribute becomes a quoted string; an {expr} attribute is
// passed through so it keeps its reactivity.
function propValues(node, declared) {
  const values = {};

  for (const name of declared) {
    const attr = node.attrs[name];

    if (!attr) {
      values[name] = 'undefined';
    } else if (attr.kind === 'static') {
      values[name] = JSON.stringify(attr.value);
    } else {
      values[name] = attr.expr;
    }
  }

  return values;
}

// Rewrites references to a component's props inside its markup with
// the caller's expressions, and drops <slot /> in favour of the
// children the caller nested inside the tag.
function substituteProps(node, values, slotChildren) {
  if (!node) return node;

  if (node.type === 'text') {
    return {
      ...node,
      parts: node.parts.map((part) => {
        if (part.kind !== 'expr') return part;

        const expr = rewrite(part.expr, values);

        // A prop passed as a plain string collapses to a literal, and
        // static text needs no effect wrapping it at runtime.
        const literal = asStringLiteral(expr);
        return literal === null ? { ...part, expr } : { kind: 'static', value: literal };
      }),
    };
  }

  if (node.type === 'element' && node.name === 'slot') {
    return { type: 'fragment', children: slotChildren };
  }

  const attrs = {};
  for (const [key, attr] of Object.entries(node.attrs ?? {})) {
    attrs[key] = attr.kind === 'expr' ? { ...attr, expr: rewrite(attr.expr, values) } : attr;
  }

  return {
    ...node,
    attrs,
    children: (node.children ?? []).map((child) => substituteProps(child, values, slotChildren)),
  };
}

// Returns the string a wholly-literal expression represents, or null
// when the expression is anything the compiler must evaluate.
function asStringLiteral(expr) {
  const match = expr.trim().match(/^\((("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*'))\)$/);
  if (!match) return null;

  try {
    return JSON.parse(match[2] ?? match[3].replace(/^'|'$/g, '"'));
  } catch {
    return null;
  }
}

// Replaces whole-word prop identifiers. Property access (obj.title)
// and string contents are left alone.
function rewrite(expr, values) {
  return expr.replace(/(?<![.\w$])([A-Za-z_$][\w$]*)/g, (match) =>
    Object.hasOwn(values, match) ? `(${values[match]})` : match
  );
}
