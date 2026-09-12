// Turns a parsed .azox AST into a JS module. The generated `render`
// function builds real DOM nodes and wires each dynamic binding to
// its own effect — no Virtual DOM tree, no diffing. A signal update
// touches exactly the text node or attribute it owns.

// This module has no Node built-ins on purpose: it runs unchanged in
// the browser, which is what makes the playground possible. Anything
// that needs to know about paths on disk belongs in build.js.

let uid = 0;
const nextId = () => `_el${uid++}`;

// Tags that open an SVG document fragment. Everything inside one is in
// the SVG namespace too, which is threaded down as `inSvg` — <circle>
// and <path> carry no hint of their own.
//
// <a> and <script> exist in both languages; they are left as HTML,
// which is what they almost always are on a page.
const SVG_TAGS = new Set(['svg']);

// Names the build resolved to constants — an inlined JSON import, say.
// An expression reading only these can never change, so it is emitted
// as text rather than wrapped in an effect. Set per compile.
let constantNames = new Set();
let constantValues = {};

// True when `expr` reads nothing that could ever change: literals,
// operators, and property paths rooted in a build-time constant.
//
// Deliberately conservative. A call, an unknown identifier, or anything
// it cannot account for means "assume it changes" — being wrong that way
// costs an effect that never fires, while the opposite silently freezes
// a binding that should update.
function isConstantExpression(expr) {
  if (!constantNames.size) return false;

  const source = expr.trim();
  if (!source) return false;

  // A call could return anything, and assignment or increment means the
  // value is meant to change.
  if (/[(]/.test(source)) return false;
  if (/(\+\+|--|[^=!<>]=[^=])/.test(source)) return false;

  // Strip strings and template literals before looking at identifiers,
  // so words inside them are not mistaken for names.
  const withoutStrings = source
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\$]|\\.|\$(?!\{))*`/g, '``');

  // A template literal with a placeholder is not handled here.
  if (/`/.test(withoutStrings) && /\$\{/.test(source)) return false;

  // Every identifier that is not a property access must be a known
  // constant. `pkg.version` yields `pkg`; `a.b.c` yields `a`.
  const roots = [...withoutStrings.matchAll(/(\.)?\b([A-Za-z_$][\w$]*)\b/g)]
    .filter(([, dot]) => !dot)
    .map(([, , name]) => name);

  if (!roots.length) return false;

  const allowed = new Set(['true', 'false', 'null', 'undefined']);
  return roots.every((name) => constantNames.has(name) || allowed.has(name));
}

// runtimeSpecifier: how the emitted module should import the Azox
//   runtime — a relative path to the copied runtime for a build, or
//   whatever the playground wants to point at.
// rewriteImports: optional hook the build uses to rebase the user's
//   own relative imports, since compiled output lives in
//   .azox/build/ rather than next to the page. Called as
//   (script, sourcePath) — an import hoisted out of a component is
//   relative to that component, not to the page. The playground has
//   no output directory, so it omits this.
// inlineModules: values the build already loaded, as local name →
//   value, whose import must not reach the browser. A JSON import
//   points outside the build directory at a file that is never
//   deployed, so the value is emitted as a constant instead.
// routeParams: the resolved parameters for this page of a dynamic
//   route. routes() is a build-time declaration and params() is
//   answered before the browser is involved, so both are removed from
//   the emitted module and the values are inlined.
export function compileToModule(
  ast,
  { runtimeSpecifier, rewriteImports, inlineModules, routeParams }
) {
  uid = 0;
  // Values the build resolved: their bindings need no effect, which is
  // what lets a page whose only "dynamic" text is a version number ship
  // as a static page.
  constantValues = inlineModules ?? {};
  constantNames = new Set(Object.keys(constantValues));
  const statements = [];
  const rootVar = emitNode(ast.markup, statements, 'root');

  let script = dropComponentImports(ast.script);
  script = resolveRouteDeclarations(script, routeParams);
  if (rewriteImports) script = rewriteImports(script);

  // A page with no bindings and no listeners has nothing to hydrate:
  // the server-rendered markup is already the finished page. Leaving
  // it alone avoids a pointless rebuild, and avoids destroying nodes
  // that other scripts on the page may be holding.
  const isStatic = !statements.some(
    (line) =>
      line.startsWith('effect(') || line.includes('.addEventListener(')
  );

  // Stateful components keep their logic inside a scope function, but
  // their imports cannot live there, so the resolver hoisted them,
  // each carrying the file it was written in. They need the same path
  // rewriting the page's own imports get — but relative to their own
  // file, not the page's — then merging with them: declaring the same
  // binding twice is a syntax error.
  let hoisted = (ast.componentImports ?? [])
    // An inlined import becomes a constant below, so the statement
    // must be dropped here too — it would declare the binding twice.
    .filter((entry) => !isInlined(entry.statement, inlineModules))
    .map((entry) =>
      rewriteImports ? rewriteImports(entry.statement, entry.path) : entry.statement
    );

  // A keyed list disposes the effects of rows that leave, so the
  // module needs dispose as well as effect.
  const needsDispose = statements.some((line) => line.includes('dispose('));
  const needsUntracked = statements.some((line) => line.includes('untracked('));

  const { imports, body } = mergeImports(
    script,
    hoisted,
    runtimeSpecifier,
    needsDispose,
    inlineModules,
    needsUntracked
  );

  // Narrowed to what the module actually reads, so importing
  // package.json for a version does not publish the whole file.
  const inlined = emitInlineModules(inlineModules, [...statements, body].join('\n'));

  return `
${imports}
${inlined}${body}

export function render(mount) {
${statements.map((line) => '  ' + line).join('\n')}
  mount.appendChild(${rootVar});
  return ${rootVar};
}
${isStatic ? staticNote() : hydrateBlock()}`.trimStart();
}

// Collects every import the module needs into one set of statements,
// pulling the page's own imports out of its script so they cannot be
// duplicated by an identical import hoisted from a component.
//
// Named imports from the same specifier are merged into one
// statement, so `signal` imported by both the page and a component is
// declared once rather than twice — which would be a syntax error.
function mergeImports(
  script,
  componentImports,
  runtimeSpecifier,
  needsDispose = false,
  inlineModules = null,
  needsUntracked = false
) {
  const pageImports = [...script.matchAll(/^\s*(import\s[^;\n]+;?)\s*$/gm)]
    .map((m) => m[1].trim())
    // An inlined import becomes a constant below, so its statement
    // must not also be emitted — the binding would be declared twice.
    .filter((line) => !isInlined(line, inlineModules));
  const body = script.replace(/^\s*import\s[^;\n]+;?\s*$/gm, '').trim();

  // specifier -> set of named bindings; anything not a plain named
  // import is kept verbatim.
  const named = new Map();
  const verbatim = new Set();

  // A page writes `azox/reactivity`; the compiler's own imports use
  // whatever runtimeSpecifier it was given. They name the same module,
  // so they are grouped under one key — otherwise a page importing
  // `signal` and a keyed list needing it emit two imports that the
  // build later rewrites to the same path, which is a redeclaration and
  // a syntax error.
  //
  // Only the grouping is normalised. The emitted specifier stays as
  // written, because rewriting it to a path on disk is the build's job —
  // the playground compiles in the browser with no build at all.
  const RUNTIME_ALIASES = new Set([
    'azox',
    'azox/reactivity',
    'azoxjs',
    'azoxjs/reactivity',
    runtimeSpecifier,
  ]);

  const record = (statement) => {
    const match = statement.match(/^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/);

    if (!match) {
      verbatim.add(statement);
      return;
    }

    const [, bindings, rawSpecifier] = match;
    // Grouped under the first spelling seen for the runtime, so the
    // page's own `azox/reactivity` survives into the output when that is
    // what was written.
    const specifier = RUNTIME_ALIASES.has(rawSpecifier)
      ? runtimeKey(named, rawSpecifier, RUNTIME_ALIASES)
      : rawSpecifier;
    const set = named.get(specifier) ?? new Set();
    for (const binding of bindings.split(',')) {
      if (binding.trim()) set.add(binding.trim());
    }
    named.set(specifier, set);
  };

  // The author's imports are recorded first, so the runtime group keeps
  // the spelling they wrote — `azox/reactivity`, which the build rewrites
  // later. Recording the compiler's own first would name the group after
  // runtimeSpecifier and rewrite the author's import here, which is the
  // build's job and would break the playground's build-free compile.
  for (const statement of [...componentImports, ...pageImports]) record(statement);

  // `effect` is always needed: the compiler emits calls to it.
  record(`import { effect } from '${runtimeSpecifier}';`);
  if (needsDispose) record(`import { dispose } from '${runtimeSpecifier}';`);
  if (needsUntracked) record(`import { untracked } from '${runtimeSpecifier}';`);

  const lines = [
    ...[...named].map(([specifier, bindings]) => {
      return `import { ${[...bindings].join(', ')} } from '${specifier}';`;
    }),
    ...verbatim,
  ];

  return { imports: lines.join('\n'), body };
}

// Returns the key the runtime's imports are already grouped under, or
// this spelling if it is the first one seen.
function runtimeKey(named, specifier, aliases) {
  for (const existing of named.keys()) {
    if (aliases.has(existing)) return existing;
  }
  return specifier;
}

// An import is inlined when every binding it declares was loaded by
// the build. Matching on the specifier would be wrong: the same file
// could be imported for some other reason.
function isInlined(statement, inlineModules) {
  if (!inlineModules) return false;

  const match = statement.match(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/);
  if (!match) return false;

  const locals = localNames(match[1]);
  return locals.length > 0 && locals.every((name) => name in inlineModules);
}

// The local names an import clause declares, for deciding whether the
// statement has been replaced by constants.
function localNames(clause) {
  const text = clause.trim();
  const names = [];

  const namespace = text.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (namespace) return [namespace[1]];

  const braceAt = text.indexOf('{');
  const head = (braceAt === -1 ? text : text.slice(0, braceAt)).replace(/,\s*$/, '').trim();
  if (/^[A-Za-z_$][\w$]*$/.test(head)) names.push(head);

  if (braceAt !== -1) {
    const closeAt = text.lastIndexOf('}');
    for (const part of text.slice(braceAt + 1, closeAt === -1 ? undefined : closeAt).split(',')) {
      const entry = part.trim();
      if (!entry) continue;
      const aliased = entry.match(/^(.+?)\s+as\s+([A-Za-z_$][\w$]*)$/);
      const local = (aliased ? aliased[2] : entry).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(local)) names.push(local);
    }
  }

  return names;
}

// Emits a loaded value as a constant. JSON.stringify is exact for what
// JSON can hold, which is all this path accepts.
function emitInlineModules(inlineModules, usage = '') {
  if (!inlineModules) return '';

  const entries = Object.entries(inlineModules);
  if (!entries.length) return '';

  const lines = entries
    // A value whose every read was folded into the markup needs no
    // declaration at all. Emitting it anyway would publish the rest of
    // the file — an author's address included — for nothing.
    .filter(([name]) => isRead(name, usage))
    .map(([name, value]) => `const ${name} = ${JSON.stringify(narrow(name, value, usage))};`);

  return lines.length ? `${lines.join('\n')}\n` : '';
}

// Whether the emitted code still mentions the binding.
function isRead(name, usage) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(usage);
}

// Keeps only the properties the module reads by name. A page that
// imports package.json for its version has no business shipping the
// author's address to every visitor, and the unread half is dead
// weight in the bundle.
//
// Narrowing applies to a plain object read as `name.prop`. Anything
// else — a primitive, an array, or a value the code indexes
// dynamically — is kept whole, since what is needed cannot be known
// from the source alone.
function narrow(name, value, usage) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // A dynamic read — name[expr] — could reach any property, and
  // passing the object on (or spreading it) could read any of them
  // later. Both mean the whole value has to stay.
  if (new RegExp(`\\b${escaped}\\s*\\[`).test(usage)) return value;
  if (new RegExp(`\\.\\.\\.\\s*${escaped}\\b`).test(usage)) return value;

  const read = new Set();
  for (const match of usage.matchAll(new RegExp(`\\b${escaped}\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
    read.add(match[1]);
  }

  // No property read by name at all: the object itself is being used,
  // so it is kept as it is.
  if (!read.size) return value;

  const narrowed = {};
  for (const key of read) {
    if (key in value) narrowed[key] = value[key];
  }

  return narrowed;
}

// Removes the build-time route declarations from a page's script.
//
// routes([...]) says which pages to build, which the browser has no
// use for — and calling it there is a ReferenceError that leaves the
// page inert. params() is replaced by the values this page was built
// with, so the markup reads them as plain data.
function resolveRouteDeclarations(script, routeParams) {
  if (!routeParams) return script;

  return script
    // A whole statement, so the trailing semicolon and newline go too.
    .replace(/^[ \t]*routes\s*\([\s\S]*?\)\s*;?[ \t]*$/gm, '')
    .replace(/\bparams\s*\(\s*\)/g, JSON.stringify(routeParams));
}

// Marks a module that does nothing on load. The build reads it to decide
// whether the page needs to reference the module at all — a static page
// that still downloads it pays for a render() nobody calls, and pulls in
// the runtime with it.
export const STATIC_MARKER = 'azox:static';

function staticNote() {
  return `
// ${STATIC_MARKER} — this page has no bindings and no listeners, so the
// server-rendered markup is already complete and is left untouched.
// render() is exported for anyone who wants to mount it somewhere else.
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

function emitNode(node, statements, fallbackVar, inSvg = false) {
  if (!node) return 'null';

  if (node.type === 'text') {
    return emitText(node, statements, fallbackVar);
  }

  // A fragment (from <slot />) has no element of its own; it wraps
  // its children in a DocumentFragment so they land in the parent.
  if (node.type === 'fragment') {
    const varName = nextId();
    statements.push(`const ${varName} = document.createDocumentFragment();`);
    appendChildren(varName, node.children, statements, fallbackVar, inSvg);
    return varName;
  }

  if (node.type === 'each') return emitEach(node, statements);
  if (node.type === 'if') return emitIf(node, statements);
  if (node.type === 'scope') return emitScope(node, statements, fallbackVar);

  const varName = nextId();

  // An SVG element needs its namespace. createElement always makes an
  // HTML element, so an inline <svg> compiled to something the browser
  // laid out as an unknown HTML tag: present in the DOM, 0×0 on screen.
  const svg = inSvg || SVG_TAGS.has(node.name);
  statements.push(
    svg
      ? `const ${varName} = document.createElementNS("http://www.w3.org/2000/svg", ${JSON.stringify(node.name)});`
      : `const ${varName} = document.createElement(${JSON.stringify(node.name)});`
  );

  for (const [key, attr] of Object.entries(node.attrs)) {
    emitAttr(varName, key, attr, statements, node.name);
  }

  appendChildren(varName, node.children, statements, fallbackVar, svg);

  return varName;
}

// A component that declares its own state becomes an immediately
// called function: its declarations are locals of that call, so two
// uses of the same component hold two independent sets of them.
//
// This is scoping the language already provides, not a component
// instance. There is nothing to mount, nothing to reconcile, and no
// object representing the component at runtime — just a function that
// runs once and returns the nodes it built.
function emitScope(node, statements, fallbackVar) {
  const varName = nextId();
  const bodyLines = [];

  const roots = node.children.map((child) => emitNode(child, bodyLines, fallbackVar));

  statements.push(`const ${varName} = ((${node.params.join(', ')}) => {`);

  // The component's own script comes first, so its declarations exist
  // before the markup that reads them is built.
  for (const line of node.script.split('\n')) {
    statements.push(`  ${line}`);
  }

  for (const line of bodyLines) statements.push(`  ${line}`);

  // A component renders one root; more than one would need a fragment,
  // and the parser already requires a single root element.
  statements.push(`  return ${roots[0] ?? 'null'};`);
  statements.push(`})(${node.args.join(', ')});`);

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

  const holder = nextId();

  statements.push(`const ${start} = document.createComment('');`);
  statements.push(`const ${end} = document.createComment('');`);

  // The markers go into their own fragment straight away, so they
  // always have a parent to insert into. Waiting for the page to be
  // mounted instead would break a nested block: its markers are
  // rebuilt every time the outer block re-runs, long after any
  // one-time mount step has passed.
  statements.push(`const ${holder} = document.createDocumentFragment();`);
  statements.push(`${holder}.append(${start}, ${end});`);

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

  statements.push(`effect(() => {`);
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
  statements.push(`});`);

  return holder;
}

function emitEach(node, statements) {
  return node.key ? emitKeyedEach(node, statements) : emitPlainEach(node, statements);
}

// A keyed list remembers the rows it built, so an update moves the
// ones that are still there instead of discarding every row and
// building it again. That is what lets a row keep its own state, its
// focus, and its scroll position across a change to the list.
//
// Rows that leave have their effects disposed, which is the one place
// the runtime's dispose() is needed: a row's bindings are created
// inside their own effect scope rather than inside the block's, since
// re-running the block must not tear down rows it is keeping.
function emitKeyedEach(node, statements) {
  const buildParams = node.index ? `${node.alias}, ${node.index}` : node.alias;

  const start = nextId();
  const end = nextId();
  const build = nextId();
  const rows = nextId();
  const holder = nextId();

  statements.push(`const ${start} = document.createComment('');`);
  statements.push(`const ${end} = document.createComment('');`);
  statements.push(`const ${holder} = document.createDocumentFragment();`);
  statements.push(`${holder}.append(${start}, ${end});`);

  // key -> { nodes, scope }. Kept across runs; this is the memory that
  // makes the list keyed rather than rebuilt.
  statements.push(`const ${rows} = new Map();`);

  // The row builder returns its nodes and the effect owning them, so
  // the block can both re-insert a row and dispose it later.
  const bodyLines = [];
  const roots = node.children.map((child) => emitNode(child, bodyLines, 'root'));

  // The index is the position the row was built at, and a keyed row is
  // built once. Reordering therefore moves rows without renumbering
  // them — the cost of keeping a row rather than rebuilding it. Use the
  // index for a stable list, and read the position from the data when a
  // list reorders.
  statements.push(`const ${build} = (${buildParams}) => {`);
  statements.push(`  let _nodes;`);
  // untracked: the row is built while the list's effect is running, so
  // without this it becomes that effect's child — and the next list
  // change tears the row down even though it survived, leaving its
  // bindings dead and its onCleanup callbacks fired.
  statements.push(`  const _scope = untracked(() => effect(() => {`);
  for (const line of bodyLines) statements.push(`    ${line}`);
  // A root may be a DocumentFragment — a component with several roots
  // returns one. A fragment empties when it is inserted and has no
  // .remove(), so its children are recorded instead; otherwise removing
  // the row threw and left it on screen with its cleanups unrun.
  statements.push(
    `    _nodes = [${roots.filter((r) => r !== 'null').join(', ')}]` +
      `.flatMap((_n) => (_n instanceof DocumentFragment ? [..._n.childNodes] : [_n]));`
  );
  statements.push(`  }));`);
  statements.push(`  return { nodes: _nodes, scope: _scope };`);
  statements.push(`};`);

  statements.push(`effect(() => {`);
  statements.push(`  const _source = ${node.expr};`);
  statements.push(`  const _parent = ${end}.parentNode;`);
  statements.push(`  if (!_parent) return;`);
  statements.push(``);
  statements.push(`  const _seen = new Set();`);
  statements.push(`  let _i = 0;`);
  statements.push(``);
  statements.push(`  for (const _item of _source ?? []) {`);
  statements.push(`    const ${node.alias} = _item;`);
  if (node.index) statements.push(`    const ${node.index} = _i;`);
  statements.push(`    const _key = ${node.key};`);
  statements.push(``);
  statements.push(`    if (_seen.has(_key)) {`);
  statements.push(`      throw new Error(`);
  statements.push(
    "        `Azox: <each> saw the key ${String(_key)} twice. Keys must be unique within a list.`"
  );
  statements.push(`      );`);
  statements.push(`    }`);
  statements.push(`    _seen.add(_key);`);
  statements.push(``);
  statements.push(`    let _row = ${rows}.get(_key);`);
  statements.push(`    if (!_row) {`);
  statements.push(`      _row = ${build}(_item${node.index ? ', _i' : ''});`);
  statements.push(`      ${rows}.set(_key, _row);`);
  statements.push(`    }`);
  statements.push(``);
  statements.push(`    // Moving a node that is already in place is a no-op in`);
  statements.push(`    // the DOM, so ordering costs nothing when nothing moved.`);
  statements.push(`    for (const _node of _row.nodes) _parent.insertBefore(_node, ${end});`);
  statements.push(`    _i++;`);
  statements.push(`  }`);
  statements.push(``);
  statements.push(`  // Whatever is left in the map is a row that has gone.`);
  statements.push(`  for (const [_key, _row] of ${rows}) {`);
  statements.push(`    if (_seen.has(_key)) continue;`);
  statements.push(`    for (const _node of _row.nodes) _node.remove();`);
  statements.push(`    dispose(_row.scope);`);
  statements.push(`    ${rows}.delete(_key);`);
  statements.push(`  }`);
  statements.push(`});`);

  return holder;
}

function emitPlainEach(node, statements) {
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

function appendChildren(parentVar, children, statements, fallbackVar, inSvg = false) {
  for (const child of children) {
    const childVar = emitNode(child, statements, fallbackVar, inSvg);
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
  node = { ...node, parts: foldConstantParts(foldLiteralParts(node.parts)) };

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

// Turns an expression the build already resolved into a literal part, so
// the text node is created with the value rather than an effect being
// attached to write it. The page whose only "dynamic" text is a version
// number then ships as a static page.
function foldConstantParts(parts) {
  if (!constantNames.size) return parts;

  return parts.map((part) => {
    if (part.kind !== 'expr' || !isConstantExpression(part.expr)) return part;

    const value = evaluateInlinedExpression(part.expr);
    if (value === undefined) return part;

    return { kind: 'literal', value: String(value) };
  });
}

// Evaluates a constant expression against the values the build resolved.
// Returns undefined when it cannot be evaluated, which leaves the part
// dynamic — the safe direction.
//
// Named for this file: the playground concatenates the compiler's
// modules into one scope, so a bare `evaluateConstant` collides with the
// one in resolveComponents.js and the whole bundle fails to parse.
function evaluateInlinedExpression(expr) {
  try {
    const names = [...constantNames];
    const fn = new Function(...names, `return (${expr});`);
    const value = fn(...names.map((name) => constantValues[name]));

    // Only a primitive can be written into the markup as text.
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'object' || typeof value === 'function') return undefined;

    return value;
  } catch {
    return undefined;
  }
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

// Properties that must be set as properties rather than attributes:
// setAttribute("value") only sets the *initial* value, so after a user
// types, writing the attribute changes nothing they can see.
const DOM_PROPERTIES = new Set(['value', 'checked', 'selected', 'indeterminate']);

function emitAttr(varName, key, attr, statements, tagName) {
  if (key.startsWith('on:')) {
    const event = key.slice(3);
    statements.push(`${varName}.addEventListener(${JSON.stringify(event)}, ${attr.expr});`);
    return;
  }

  if (key.startsWith('bind:')) {
    emitBinding(varName, key.slice(5), attr, statements, tagName);
    return;
  }

  if (attr.kind === 'static') {
    statements.push(`${varName}.setAttribute(${JSON.stringify(key)}, ${JSON.stringify(attr.value)});`);
    return;
  }

  // A property has to be assigned, not set as an attribute — see
  // DOM_PROPERTIES. Everything else is an attribute.
  if (DOM_PROPERTIES.has(key)) {
    statements.push(`effect(() => { ${varName}.${key} = ${attr.expr}; });`);
    return;
  }

  // Dynamic attribute: wrap in its own effect, same fine-grained rule as text.
  statements.push(`effect(() => { ${varName}.setAttribute(${JSON.stringify(key)}, String(${attr.expr})); });`);
}

// Two-way binding: the element shows the signal, and the signal follows
// the element. Writing it by hand means a value= and an on:input= that
// have to agree, and getting the event or the property wrong is easy —
// a checkbox reports `checked`, not `value`, and a number input reports
// a string.
function emitBinding(varName, property, attr, statements, tagName) {
  const signal = attr.expr.trim();

  // The signal itself, not a call: `bind:value={draft}`. Binding needs
  // to write back, which a value cannot do.
  if (!/^[A-Za-z_$][\w$]*$/.test(signal)) {
    throw new Error(
      `Azox: bind:${property}={${signal}} needs a signal by name — ` +
        `write bind:${property}={draft}, not bind:${property}={draft()}`
    );
  }

  // A checkbox's state is `checked`, and the event that reports it is
  // "change" rather than "input".
  const isCheckbox = property === 'checked';
  const event = isCheckbox || tagName === 'select' ? 'change' : 'input';

  statements.push(`effect(() => { ${varName}.${property} = ${signal}(); });`);
  statements.push(
    `${varName}.addEventListener(${JSON.stringify(event)}, (_e) => ` +
      `${signal}.set(${readTarget(property, tagName)}));`
  );
}

// How the value is read back off the element. A number input reports a
// string, so it is converted — otherwise arithmetic on the signal
// silently concatenates.
function readTarget(property, tagName) {
  if (property === 'checked') return '_e.target.checked';
  if (tagName === 'input') return '(_e.target.type === "number" ? _e.target.valueAsNumber : _e.target.value)';
  return '_e.target.value';
}

// Component imports are resolved at build time and inlined, so the
// .azox specifier must not survive into JavaScript the browser loads.
function dropComponentImports(script) {
  return script.replace(/^\s*import\s+[A-Z]\w*\s+from\s+['"][^'"]+\.azox['"]\s*;?\s*$/gm, '');
}

