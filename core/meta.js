// Single source of truth for version and identity strings. Reading
// from package.json means `azox -v` can never drift out of sync with
// what npm publishes.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8'));

export const VERSION = pkg.version;
export const TAGLINE = 'The Sound of Future Web';
export const BANNER = `Azox Framework v${VERSION} - ${TAGLINE}`;
