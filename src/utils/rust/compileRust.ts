import {
  initCarciniScript,
  compile,
  hover,
  completions,
  signatureHelp,
  definition,
  references,
  rename,
  setNsBindings,
  setOverflowChecks,
  setStrictBorrows,
  type Completion,
  type SignatureHelp,
  type Diagnostic,
  type Hover,
  type Location,
} from "carciniscript";
// Installs globalThis.κσ, the runtime helpers that compiled Rust scripts call.
import "carciniscript/runtime";
import { nsBindings } from "./NsBindings.generated";
import { Settings } from "../../Settings/Settings";
import type { Script } from "../../Script/Script";
import type { ScriptFilePath } from "../../Paths/ScriptFilePath";

/** The scripts on a server, which `mod name;` reads `name.rs` from. */
type Scripts = ReadonlyMap<ScriptFilePath, Script>;

function resolverFor(scripts: Scripts | undefined): (path: string) => string | undefined {
  return (path) => scripts?.get(path as ScriptFilePath)?.code;
}

/** Load the CarciniScript compiler (wasm). Called once at startup, next to swc's init. */
export async function initRust(): Promise<void> {
  await initCarciniScript();
}

let bindingsInstalled = false;

/**
 * Install the typed NS bindings before the first compile. Lazy rather than in initRust so that
 * code paths that never run the loading screen (tests) get them too.
 */
function ensureBindings(): void {
  if (bindingsInstalled) return;
  bindingsInstalled = true;
  const problems = setNsBindings(nsBindings);
  if (problems.length) console.error("CarciniScript NS bindings:", problems);
}

/** Thrown when Rust source has compile errors. `diagnostics` carries every error and warning. */
export class RustCompileError extends Error {
  constructor(message: string, public readonly diagnostics: Diagnostic[]) {
    super(message);
    this.name = "RustCompileError";
  }
}

export function formatRustDiagnostic(filename: string, d: Diagnostic): string {
  const first = `${filename}:${d.line}:${d.column}: ${d.message}`;
  // The help line (the rule, for players who don't know Rust) on a second, indented line.
  return d.help ? `${first}\n    ${d.help}` : first;
}

/**
 * Compile a `.rs` script to an ES module plus a v3 source map. Synchronous, like swc's
 * transformSync: Bitburner's module loading must not await between reading and evaluating code.
 * `scripts` (the server's scripts) supplies the files of `mod` declarations.
 */
export function compileRust(
  code: string,
  filename: string,
  scripts?: Scripts,
): { scriptCode: string; sourceMap: string; diagnostics: Diagnostic[]; dependencies: string[] } {
  ensureBindings();
  setOverflowChecks(true);
  setStrictBorrows(true);
  const out = compile(code, filename, resolverFor(scripts));
  if (out.code === null || out.sourceMap === null) {
    const errors = out.diagnostics.filter((d) => d.severity === "error");
    const first = errors[0] ?? out.diagnostics[0];
    const more = errors.length > 1 ? ` (and ${errors.length - 1} more error${errors.length > 2 ? "s" : ""})` : "";
    const message = first ? `${formatRustDiagnostic(filename, first)}${more}` : `${filename}: compilation failed`;
    throw new RustCompileError(message, out.diagnostics);
  }
  return {
    scriptCode: out.code,
    sourceMap: out.sourceMap,
    diagnostics: out.diagnostics,
    // Proc-macro crates it used (its `mod` files are JS imports, tracked like any other).
    dependencies: out.dependencies,
  };
}

/** Hover text (markdown) at a 1-based line and column, for the editor. */
export function getRustHover(
  code: string,
  filename: string,
  line: number,
  column: number,
  scripts?: Scripts,
): Hover | null {
  ensureBindings();
  return hover(code, filename, line, column, resolverFor(scripts));
}

/** Members of the value before a `.` at a 1-based line and column, for editor completion. */
export function getRustCompletions(
  code: string,
  filename: string,
  line: number,
  column: number,
  scripts?: Scripts,
): Completion[] {
  ensureBindings();
  return completions(code, filename, line, column, resolverFor(scripts));
}

/** Parameter hints for the call around a 1-based line and column, for the editor. */
export function getRustSignatureHelp(
  code: string,
  filename: string,
  line: number,
  column: number,
  scripts?: Scripts,
): SignatureHelp | null {
  ensureBindings();
  return signatureHelp(code, filename, line, column, resolverFor(scripts));
}

/** Diagnostics only, for editor markers. Never throws. */
export function getRustDiagnostics(code: string, filename: string, scripts?: Scripts): Diagnostic[] {
  ensureBindings();
  return compile(code, filename, resolverFor(scripts)).diagnostics;
}

/** Where the name at a 1-based line and column is defined (in this file or another script). */
export function getRustDefinition(
  code: string,
  filename: string,
  line: number,
  column: number,
  scripts?: Scripts,
): Location | null {
  ensureBindings();
  return definition(code, filename, line, column, resolverFor(scripts));
}

/** The `.rs` scripts of a server, which references and renames search too. */
function rustPaths(scripts: Scripts | undefined): string[] {
  return [...(scripts?.keys() ?? [])].filter((p) => p.endsWith(".rs"));
}

/** Every use of the name at a 1-based line and column, its declaration included, in this and the server's other `.rs` scripts. */
export function getRustReferences(
  code: string,
  filename: string,
  line: number,
  column: number,
  scripts?: Scripts,
): Location[] {
  ensureBindings();
  return references(code, filename, line, column, resolverFor(scripts), rustPaths(scripts));
}

/** The ranges to replace with `newName` to rename the name at a 1-based line and column, in this and the server's other `.rs` scripts. */
export function getRustRename(
  code: string,
  filename: string,
  line: number,
  column: number,
  newName: string,
  scripts?: Scripts,
): Location[] {
  ensureBindings();
  return rename(code, filename, line, column, newName, resolverFor(scripts), rustPaths(scripts));
}
