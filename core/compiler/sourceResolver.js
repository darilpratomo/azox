// How the compiler finds the source of an imported component.
//
// The compiler itself never touches a filesystem. It asks a resolver
// to turn an import specifier into an identity and a source string,
// which lets the same compiler run against files on disk (the CLI)
// and against an in-memory map (the browser playground) with no
// duplicated logic.
//
// A resolver implements:
//   resolve(specifier, fromId) -> id      a stable, absolute identity
//   read(id)                   -> string  the source, or null if absent

// Joins POSIX-style paths and collapses "." and "..", so the browser
// resolver behaves like the Node one without importing node:path.
export function joinPath(base, specifier) {
  const segments = specifier.startsWith('/')
    ? specifier.split('/')
    : [...base.split('/').slice(0, -1), ...specifier.split('/')];

  const out = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }

  return `/${out.join('/')}`;
}

// Resolver over a plain object of { "/path/File.azox": "source" }.
// Used by the playground, and by tests that would rather not touch
// the filesystem.
export function createMemoryResolver(files) {
  const normalised = new Map(
    Object.entries(files).map(([path, source]) => [path.startsWith('/') ? path : `/${path}`, source])
  );

  return {
    resolve: (specifier, fromId) => joinPath(fromId, specifier),
    read: (id) => normalised.get(id) ?? null,
  };
}
