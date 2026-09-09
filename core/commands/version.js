// `azox version` / `azox -v` / `azox --version`

import { VERSION } from '../meta.js';

export function versionCommand() {
  console.log(`azox v${VERSION}`);
}
