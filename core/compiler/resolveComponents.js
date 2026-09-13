// Resolves <Component /> usage at build time by inlining each
// component's markup into its caller.
//
// Nothing survives into the runtime: there is no component instance,
// no lifecycle, no reconciliation. A component is a compile-time unit
// of reuse, so the emitted code looks the same as if the markup had
// been written by hand.

import { parseAzox } from './parser.js';
import { scopeId, scopeAttribute, scopeCss } from './scopeStyles.js';
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
export function resolveComponents(
  ast,
  sourcePath,
  resolver,
  seen = new Set(),
  heads = null,
  styles = null
) {
  // Imports from stateful components are hoisted here: they cannot
  // live inside the scope function the compiler builds for each one.
  //
  // Each entry carries the file it was written in. A relative
  // specifier means something different depending on where it was
  // written, so the owning path has to travel with the statement —
  // rebasing a component's import against the page's directory points
  // it at a file that is not there.
  const hoisted = new Map();

  // A component's <head> block is collected the same way, keyed by the
  // file it came from so the same component used twice contributes
  // once. A stylesheet link belongs in the document head, and until
  // now only a page could put one there.
  const collected = heads ?? new Map();

  // A component's <style> block is collected the same way and keyed by
  // the same path, so a component used twice contributes its CSS once.
  const collectedStyles = styles ?? new Map();

  const markup = expand(
    ast.markup,
    ast,
    sourcePath,
    resolver,
    seen,
    hoisted,
    collected,
    collectedStyles
  );

  return {
    ...ast,
    markup,
    componentImports: [...hoisted.values()],
    componentHeads: [...collected.values()],
    componentStyles: [...collectedStyles.values()],
  };
}

function expand(node, ast, sourcePath, resolver, seen, hoisted, heads, styles) {
  if (!node || node.type === 'text') return node;

  // <if> keeps its children in two branches rather than in `children`,
  // so walking only `children` would leave components inside a
  // conditional unresolved — they would reach the output as raw tags.
  if (node.type === 'if') {
    return {
      ...node,
      then: node.then.map((child) =>
        expand(child, ast, sourcePath, resolver, seen, hoisted, heads, styles)
      ),
      otherwise: node.otherwise.map((child) =>
        expand(child, ast, sourcePath, resolver, seen, hoisted, heads, styles)
      ),
    };
  }

  const children = (node.children ?? []).map((child) =>
    expand(child, ast, sourcePath, resolver, seen, hoisted, heads, styles)
  );

  if (node.type !== 'component') {
    return { ...node, children };
  }

  const component = loadComponent(node.name, ast, sourcePath, resolver, seen);
  validateProps(node, component);

  // The component's own body may reference further components, so
  // expand it against its own imports and its own location.
  const inner = resolveComponents(
    component.ast,
    component.path,
    resolver,
    new Set([...seen, component.path]),
    heads,
    styles
  );

  // Keyed by path: a component used on a page twice must not emit its
  // stylesheet link twice.
  if (component.ast.head) heads.set(component.path, component.ast.head);

  // A <style> block scopes to this component: its selectors are
  // rewritten to require an attribute, and that attribute is put on the
  // markup below. Both halves key off the same path, so the CSS and the
  // elements it targets always agree.
  let scope = null;

  if (component.ast.style) {
    scope = scopeId(component.path);
    styles.set(component.path, scopeCss(component.ast.style, scope));
  }

  if (scope) markScope(inner.markup, scopeAttribute(scope));

  const values = propValues(node, component.ast.props);
  const { logic, imports } = componentLogic(component.ast.script);

  // Imports are hoisted whether or not the component has logic: a
  // component whose script is only an import still has markup that
  // references what it imported, and dropping the import left that
  // name undefined.
  for (const line of imports) {
    hoisted.set(`${component.path}\u0000${line}`, { statement: line, path: component.path });
  }

  // Imports the component's own body pulled up are needed by anything
  // nested inside it too, and keep the path they were written against.
  for (const entry of inner.componentImports ?? []) {
    hoisted.set(`${entry.path}\u0000${entry.statement}`, entry);
  }

  // Without logic the component is inlined outright, and its props are
  // rewritten to the caller's expressions in place.
  if (!logic) {
    return substituteProps(inner.markup, values, children);
  }

  // With logic the markup gets a scope of its own, so each use has its
  // own copy of whatever the component declares — two <Counter /> tags
  // hold two independent counts rather than colliding over one
  // binding. Props become parameters of that scope, so they are left
  // as names here rather than being replaced by the caller's
  // expressions; the values are passed in as arguments instead.
  const markup = substituteProps(inner.markup, {}, children);

  // This is ordinary JavaScript scoping, not a component instance:
  // nothing about it survives into the runtime.
  return {
    type: 'scope',
    name: node.name,
    script: logic,
    params: component.ast.props,
    args: component.ast.props.map((prop) => values[prop] ?? 'undefined'),
    children: [markup],
  };
}

// Splits a component's script into the imports it needs and the logic
// that belongs inside its scope.
//
// Imports cannot live inside a function, so they are hoisted to the
// module and collected on the AST for the compiler to emit. What is
// left — minus the props() line, which becomes parameters — is the
// component's own logic. `logic` is null when there is none, which is
// what lets a purely presentational component stay inlined.
function componentLogic(script) {
  if (!script) return { logic: null, imports: [] };

  const imports = [...script.matchAll(/^\s*(import\s[^;\n]+;?)\s*$/gm)]
    .map((match) => match[1].trim())
    // Component imports are resolved at build time and must not reach
    // the browser as a .azox specifier.
    .filter((line) => !/\.azox['"]/.test(line));

  const body = script
    .replace(/^\s*import\s.+?;?\s*$/gm, '')
    .replace(/const\s*\{[^}]*\}\s*=\s*props\(\)\s*;?/, '');

  // Comments alone are not logic.
  const meaningful = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  return { logic: meaningful.trim() ? body.trim() : null, imports };
}

// Puts the scope attribute on every element the component owns.
//
// Slot content is skipped: it was written by whoever used the tag, so
// it belongs to the caller's scope, and a component must not restyle
// markup it did not write.
function markScope(node, attribute) {
  if (!node || node.type === 'text') return;

  if (node.type === 'fragment' && node.slot) return;

  if (node.type === 'element' || node.type === 'component') {
    node.attrs = { ...node.attrs, [attribute]: { kind: 'static', value: '' } };
  }

  if (node.type === 'if') {
    for (const child of [...(node.then ?? []), ...(node.otherwise ?? [])]) {
      markScope(child, attribute);
    }
    return;
  }

  for (const child of node.children ?? []) markScope(child, attribute);
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
    // Marked as slot content: it was written by the caller, so it
    // must be rendered against the caller's scope rather than the
    // component's. Without this a component's own declarations would
    // shadow — or hide entirely — whatever the caller referenced.
    return { type: 'fragment', slot: true, children: slotChildren };
  }

  // Control flow holds its expression and its children outside the
  // usual `attrs`/`children` shape, so it needs substituting by hand.
  // Without this, a component that loops over one of its own props
  // compiles to an expression referring to a name that does not exist.
  if (node.type === 'each') {
    // The list expression is evaluated outside the loop, so it still
    // sees the props. Only the body is shadowed by the loop variable.
    const inner = shadow(values, [node.alias, node.index]);

    return {
      ...node,
      expr: rewrite(node.expr, values),
      children: node.children.map((child) => substituteProps(child, inner, slotChildren)),
    };
  }

  if (node.type === 'if') {
    return {
      ...node,
      expr: rewrite(node.expr, values),
      then: node.then.map((child) => substituteProps(child, values, slotChildren)),
      otherwise: node.otherwise.map((child) => substituteProps(child, values, slotChildren)),
    };
  }

  const attrs = {};
  for (const [key, attr] of Object.entries(node.attrs ?? {})) {
    if (attr.kind !== 'expr' || key.startsWith('on:')) {
      attrs[key] = attr;
      continue;
    }

    const expr = rewrite(attr.expr, values);

    // Once the caller's props are substituted in, an expression may
    // have become entirely constant — `class={current === 'docs' ? …}`
    // with a literal `current`, for instance. Folding it here means
    // no effect is created for a value that can never change, and a
    // page built only from such components stays static.
    const folded = evaluateConstant(expr);
    attrs[key] = folded === null ? { ...attr, expr } : { kind: 'static', value: folded };
  }

  return {
    ...node,
    attrs,
    children: (node.children ?? []).map((child) => substituteProps(child, values, slotChildren)),
  };
}

// Evaluates an expression that refers to nothing outside itself, and
// returns the resulting string — or null if it cannot be folded.
//
// Deliberately conservative: anything containing an identifier that
// is not a literal or a keyword is refused, so this can never run a
// function call, read a signal, or touch anything with a side effect.
// Only string, number and boolean results are folded, since those are
// the only ones that render the same at build time as at runtime.
const FOLDABLE_KEYWORDS = new Set(['true', 'false', 'null', 'undefined']);

function evaluateConstant(expr) {
  // Strip strings first, then look for anything identifier-shaped in
  // what remains.
  const withoutStrings = expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '');
  const identifiers = withoutStrings.match(/[A-Za-z_$][\w$]*/g) ?? [];

  if (identifiers.some((name) => !FOLDABLE_KEYWORDS.has(name))) return null;

  // With no identifiers left, a "(" can only be grouping — there is
  // nothing available to call. Braces, brackets, semicolons, arrows
  // and assignment are still refused outright.
  if (/[{}[\];]|=>/.test(withoutStrings)) return null;
  if (/(^|[^!=<>])=([^=]|$)/.test(withoutStrings)) return null;

  try {
    const value = new Function(`"use strict"; return (${expr});`)();
    const type = typeof value;

    if (type === 'string' || type === 'number' || type === 'boolean') return String(value);
    return null;
  } catch {
    return null;
  }
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

// A loop variable shadows a prop of the same name, the way a
// parameter shadows an outer binding in JavaScript. Removing the
// shadowed names stops the loop body from being rewritten to the
// caller's value.
function shadow(values, names) {
  const shadowed = names.filter(Boolean);
  if (!shadowed.some((name) => name in values)) return values;

  const next = { ...values };
  for (const name of shadowed) delete next[name];
  return next;
}

// Replaces whole-word prop identifiers. Property access (obj.title)
// and string contents are left alone.
function rewrite(expr, values) {
  return expr.replace(/(?<![.\w$])([A-Za-z_$][\w$]*)/g, (match) =>
    Object.hasOwn(values, match) ? `(${values[match]})` : match
  );
}
