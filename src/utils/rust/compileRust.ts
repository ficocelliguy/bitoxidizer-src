import {
  initCarciniScript,
  compile,
  hover,
  completions,
  signatureHelp,
  setNsBindings,
  type Completion,
  type SignatureHelp,
  type Diagnostic,
  type Hover,
} from "carciniscript";
// Installs globalThis.κσ, the runtime helpers that compiled Rust scripts call.
import "carciniscript/runtime";
import { nsBindings } from "./NsBindings.generated";
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
  return `${filename}:${d.line}:${d.column}: ${d.message}`;
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
): { scriptCode: string; sourceMap: string; diagnostics: Diagnostic[] } {
  ensureBindings();
  const out = compile(code, filename, resolverFor(scripts));
  if (out.code === null || out.sourceMap === null) {
    const errors = out.diagnostics.filter((d) => d.severity === "error");
    const first = errors[0] ?? out.diagnostics[0];
    const more = errors.length > 1 ? ` (and ${errors.length - 1} more error${errors.length > 2 ? "s" : ""})` : "";
    const message = first ? `${formatRustDiagnostic(filename, first)}${more}` : `${filename}: compilation failed`;
    throw new RustCompileError(message, out.diagnostics);
  }
  return { scriptCode: out.code, sourceMap: out.sourceMap, diagnostics: out.diagnostics };
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
