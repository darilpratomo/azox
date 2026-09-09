import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../core/cli/parseArgs.js';

test('reads the command from the first argument', () => {
  assert.equal(parseArgs(['compile']).command, 'compile');
});

test('has no command when none is given', () => {
  assert.equal(parseArgs([]).command, null);
});

test('a leading flag is not treated as a command', () => {
  const { command, flags } = parseArgs(['-v']);
  assert.equal(command, null);
  assert.equal(flags.v, true);
});

test('parses long boolean flags', () => {
  assert.equal(parseArgs(['dev', '--watch']).flags.watch, true);
});

test('parses valued flags', () => {
  assert.equal(parseArgs(['compile', '--page=about']).flags.page, 'about');
});

test('keeps "=" inside a flag value', () => {
  assert.equal(parseArgs(['run', '--expr=a=b']).flags.expr, 'a=b');
});

test('parses short flags', () => {
  assert.deepEqual(parseArgs(['-h']).flags, { h: true });
});

test('collects positionals after the command', () => {
  const { command, positionals } = parseArgs(['create', 'my-app']);
  assert.equal(command, 'create');
  assert.deepEqual(positionals, ['my-app']);
});

test('separates positionals from flags in any order', () => {
  const { positionals, flags } = parseArgs(['create', '--force', 'my-app']);
  assert.deepEqual(positionals, ['my-app']);
  assert.equal(flags.force, true);
});

test('an empty valued flag yields an empty string, not true', () => {
  assert.equal(parseArgs(['compile', '--page=']).flags.page, '');
});
