// Types for `azoxjs/compiler`.
//
// The compiler is free of Node built-ins on purpose, so these describe
// an API that runs in a browser as well as in the build.

/** A parsed `.azox` file. The node shapes are internal and may change. */
export interface AzoxAst {
  /** The `<script>` block, with its imports intact. */
  script: string;
  /** The `<head>` block, verbatim. */
  head: string;
  /** The markup, as a tree the compiler and renderer both walk. */
  markup: unknown;
  /** Component name → the specifier it was imported from. */
  components: Record<string, string>;
  /** Prop names the file declared with `props()`. */
  props: string[];
  /** Route parameter names the file declared with `params()`. */
  params: string[];
}

export interface CompileOptions {
  /** How the emitted module should import the runtime. */
  runtimeSpecifier: string;
  /**
   * Rebases the author's relative imports, since compiled output does
   * not sit beside the source. Called with the file an import was
   * written in, which differs from the page for a hoisted one.
   */
  rewriteImports?: (script: string, sourcePath?: string) => string;
  /** Values the build resolved, inlined instead of imported. */
  inlineModules?: Record<string, unknown>;
  /** Resolved parameters for one page of a dynamic route. */
  routeParams?: Record<string, string> | null;
}

/** Parses a `.azox` file. Throws on malformed markup, naming the tag. */
export declare function parseAzox(source: string): AzoxAst;

/** Compiles a parsed file into a JavaScript module, as a string. */
export declare function compileToModule(ast: AzoxAst, options: CompileOptions): string;
