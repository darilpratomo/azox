// The filesystem-backed resolver used by the CLI.
//
// It lives outside core/compiler/ on purpose: everything under
// core/compiler/ must stay free of Node built-ins so it can run in a
// browser. This is the one place that bridges the compiler to disk.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function createNodeResolver() {
  return {
    resolve: (specifier, fromId) => resolve(dirname(fromId), specifier),
    read: (id) => (existsSync(id) ? readFileSync(id, 'utf8') : null),
  };
}
