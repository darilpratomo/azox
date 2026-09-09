// Recursive file watching with debounce.
//
// fs.watch fires several times for one save (editors write, rename
// and touch metadata separately), so events are coalesced into a
// single callback. Node's `recursive: true` works on macOS and
// Windows; on Linux it needs Node 20+, so a manual fallback walks
// subdirectories and watches each one.

import { watch, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEBOUNCE_MS = 40;

export function watchDirectory(dir, onChange, { filter = () => true } = {}) {
  const watchers = [];
  let timer = null;

  const trigger = (filename) => {
    if (filename && !filter(filename)) return;

    clearTimeout(timer);
    timer = setTimeout(() => onChange(filename), DEBOUNCE_MS);
  };

  try {
    watchers.push(watch(dir, { recursive: true }, (_event, filename) => trigger(filename)));
  } catch {
    // Recursive mode unavailable: watch this directory and each
    // subdirectory found at startup.
    for (const target of [dir, ...subdirectories(dir)]) {
      watchers.push(watch(target, (_event, filename) => trigger(filename)));
    }
  }

  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}

function subdirectories(dir) {
  const found = [];

  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;

    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(full, ...subdirectories(full));
  }

  return found;
}
