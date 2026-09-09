// Lives on its own so both the build pipeline and the compiler can
// use it without importing each other.
//
// A BuildError means the user's project is wrong — a missing page, a
// bad component reference — and the CLI prints its message plainly.
// Anything else that escapes is a bug in Azox and keeps its stack.

export class BuildError extends Error {}
