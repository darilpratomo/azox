// Parses the import statements in a <script> block so the server can
// supply what they bring in.
//
// The compiler hoists a plain JS import into the emitted module, so
// the browser loads it natively. Server rendering has no module
// context — the script runs inside a `new Function` — so the bindings
// are resolved here and passed in as arguments instead.
//
// `azox/reactivity` is the exception: the server supplies its own
// non-reactive primitives rather than loading the real runtime.

const RUNTIME_SPECIFIERS = new Set(['azox/reactivity', 'azoxjs/reactivity']);

// Matches the import forms a .azox script can use:
//   import x from '…'              default
//   import { a, b as c } from '…'  named
//   import * as ns from '…'        namespace
//   import '…'                     side effect only
//
// A trailing import attribute — `with { type: 'json' }`, which is how
// a script reads package.json — is matched and ignored; Node applies
// it when the module is actually loaded.
const IMPORT_RE =
  /^[ \t]*import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"][ \t]*(?:(?:with|assert)\s*\{[^}]*\})?[ \t]*;?[ \t]*$/gm;

// Returns one entry per import that the server must resolve, each
// naming the specifier and the local bindings it introduces.
export function parseImports(script) {
  if (!script) return [];

  const found = [];

  for (const match of script.matchAll(IMPORT_RE)) {
    const [, clause, specifier] = match;

    if (RUNTIME_SPECIFIERS.has(specifier)) continue;
    // A .azox import is a component, resolved at build time.
    if (specifier.endsWith('.azox')) continue;
    // Side-effect-only import introduces no bindings, and the server
    // has nothing to bind, so there is nothing to do.
    if (!clause) continue;

    found.push({ specifier, bindings: parseClause(clause) });
  }

  return found;
}

// Turns the text between `import` and `from` into the local names it
// declares, each paired with the export it comes from. A default
// import reads the `default` export; a namespace import takes the
// module object itself.
function parseClause(clause) {
  const bindings = [];
  const text = clause.trim();

  const namespace = text.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (namespace) return [{ local: namespace[1], imported: '*' }];

  // A default import may be followed by a named list:
  //   import def, { a, b } from '…'
  const braceAt = text.indexOf('{');
  const head = (braceAt === -1 ? text : text.slice(0, braceAt)).replace(/,\s*$/, '').trim();

  if (head) {
    const ns = head.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (ns) bindings.push({ local: ns[1], imported: '*' });
    else if (/^[A-Za-z_$][\w$]*$/.test(head)) bindings.push({ local: head, imported: 'default' });
  }

  if (braceAt !== -1) {
    const closeAt = text.lastIndexOf('}');
    const names = text.slice(braceAt + 1, closeAt === -1 ? undefined : closeAt);

    for (const part of names.split(',')) {
      const entry = part.trim();
      if (!entry) continue;

      const aliased = entry.match(/^(.+?)\s+as\s+([A-Za-z_$][\w$]*)$/);
      const imported = (aliased ? aliased[1] : entry).trim();
      const local = aliased ? aliased[2] : imported;

      if (/^[A-Za-z_$][\w$]*$/.test(local)) bindings.push({ local, imported });
    }
  }

  return bindings;
}
