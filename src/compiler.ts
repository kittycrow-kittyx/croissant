import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { readManifest } from "./manifest.js";
import { CompilerError, Context, cIdentifier } from "./context.js";
import { Emitter } from "./emitter.js";
import { emitProject } from "./project.js";

export type CompileRequest = { readonly manifestPath: string } & (
  { readonly outputPath: string } | { readonly outputDir: string }
);

export interface CompileResult {
  readonly files: number;
  readonly functions: number;
  readonly globals: number;
  readonly interfaces: number;
  readonly outputPath: string;
  readonly generatedFiles: readonly string[];
}

const header = [
  "/* Croissant: generated from Bake --target=clang. Do not edit. */",
  "/* Platform must implement the declared __bake_c_* ABI. */",
  "#include <stdint.h>",
  "#include <stdbool.h>",
  "#include <stddef.h>",
  "/* Native numeric intrinsics preserve JavaScript 32-bit operations. */",
  "extern int32_t croissant_js_and(double, double);",
  "extern int32_t croissant_js_or(double, double);",
  "extern int32_t croissant_js_xor(double, double);",
  "extern int32_t croissant_js_shl(double, double);",
  "extern int32_t croissant_js_shr(double, double);",
  "extern uint32_t croissant_js_ushr(double, double);",
  "extern int32_t croissant_js_not(double);",
  "extern double croissant_js_remainder(double, double);",
  ""
].join("\n");

function nativeIndex(member: ts.IndexSignatureDeclaration): boolean {
  const parameter = member.parameters[0] ?? null;
  const key = parameter ? parameter.type ?? null : null;
  return member.parameters.length === 1 && key !== null && key.kind === ts.SyntaxKind.NumberKeyword &&
    [ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BigIntKeyword].includes(member.type.kind);
}

function loadProgram(root: string, sourcesListed: readonly string[]): { program: ts.Program; files: string[] } {
  const files = sourcesListed.map(relative => {
    const abs = path.resolve(root, relative);
    const local = path.relative(root, abs);
    if (local.startsWith("..") || path.isAbsolute(local) || !abs.endsWith(".ts")) {
      throw new Error("CR004: invalid source path in Bake manifest: " + relative);
    }
    if (!fs.existsSync(abs)) throw new Error("CR005: manifest references missing source: " + relative);
    return abs;
  });
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    types: [],
    skipLibCheck: true,
    noEmit: true
  });
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => d.category === ts.DiagnosticCategory.Error);
  const d = diagnostics[0] ?? null;
  if (d) {
    const source = d.file ?? null;
    const offset = d.start ?? null;
    const file = source ? source.fileName : "<typescript>";
    const at = source && offset !== null ? source.getLineAndCharacterOfPosition(offset).line + 1 : 0;
    throw new Error("CR006: Bake output failed TypeScript checking (" + diagnostics.length + " errors). " +
      path.relative(root, file) + ":" + at + ": " + ts.flattenDiagnosticMessageText(d.messageText, " "));
  }
  return { program, files };
}

export function compile(request: CompileRequest): CompileResult {
  if (("outputPath" in request) === ("outputDir" in request))
    throw new Error("CR000: specify exactly one of --out or --out-dir");
  const manifestPath = path.resolve(request.manifestPath);
  const root = path.dirname(manifestPath);
  const sourcesListed = readManifest(fs.readFileSync(manifestPath, "utf8"));
  const { program, files } = loadProgram(root, sourcesListed);
  const ctx: Context = new Context(program, root);
  const sourceFiles = files.map(file => {
    const source = program.getSourceFile(file) ?? null;
    if (!source) throw new Error("CR005: manifest source not loaded: " + file);
    return source;
  });
  const globals: Array<{ name: string; declaration: ts.VariableDeclaration }> = [];
  const functions: Array<{ name: string; declaration: ts.FunctionDeclaration }> = [];
  const structs: Array<{ name: string; declaration: ts.InterfaceDeclaration }> = [];
  const externals = new Map<string, ts.FunctionDeclaration>();

  // Register every module's symbols before compiling bodies so imported references resolve.
  const registerInterface = (source: ts.SourceFile, statement: ts.InterfaceDeclaration): void => {
    const name = statement.name.text.startsWith("__bake_c_") ? statement.name.text : ctx.module(source) + "__" + statement.name.text;
    ctx.register(statement.name, name);
    if (!structs.some(entry => entry.name === name)) structs.push({ name, declaration: statement });
  };
  const registerFunction = (source: ts.SourceFile, statement: ts.FunctionDeclaration, id: ts.Identifier): void => {
    const name = id.text.startsWith("__bake_c_") ? id.text : ctx.module(source) + "__" + id.text;
    ctx.register(id, name);
    const intrinsic = name.startsWith("__bake_c_");
    if (intrinsic && (statement.body ?? null)) ctx.fail(statement, "CR301", "compiler intrinsic must be external");
    if (!intrinsic) { functions.push({ name, declaration: statement }); return; }
    if (!externals.has(name)) externals.set(name, statement);
  };
  const registerGlobals = (source: ts.SourceFile, statement: ts.VariableStatement): void => {
    for (const decl of statement.declarationList.declarations) {
      const id = decl.name;
      if (!ts.isIdentifier(id)) ctx.fail(decl, "CR302", "top-level destructuring unsupported");
      const name = ctx.module(source) + "__" + id.text;
      ctx.register(id, name);
      globals.push({ name, declaration: decl });
    }
  };
  for (const source of sourceFiles) {
    for (const statement of source.statements) {
      if (ts.isInterfaceDeclaration(statement)) { registerInterface(source, statement); continue; }
      if (ts.isFunctionDeclaration(statement)) {
        const name = statement.name ?? null;
        if (!name) ctx.fail(statement, "CR303", "anonymous function declaration");
        registerFunction(source, statement, name); continue;
      }
      if (ts.isVariableStatement(statement)) { registerGlobals(source, statement); continue; }
      if (ts.isTypeAliasDeclaration(statement) || ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isEmptyStatement(statement)) continue;
      ctx.fail(statement, "CR303", "unsupported module declaration " + ts.SyntaxKind[statement.kind]);
    }
  }

  const emitter = new Emitter(ctx);
  const text: string[] = [header];

  // Forward declarations permit references to record types across modules.
  for (const struct of structs) {
    text.push("typedef struct " + struct.name + " " + struct.name + ";");
  }
  text.push("");

  // Resolve record dependencies before emitting by-value fields.
  const available = new Set<string>();
  const pending = [...structs];
  let rounds = 0;
  while (pending.length) {
    if (++rounds > structs.length + 1) throw new Error("CR304: cyclic or incomplete native record layout");
    let advanced = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const item = pending[i] ?? null;
      if (!item) throw new Error("CR304: missing pending record");
      const properties = item.declaration.members.filter(ts.isPropertySignature);
      for (const member of item.declaration.members) {
        if (ts.isPropertySignature(member)) continue;
        if (ts.isIndexSignatureDeclaration(member) && nativeIndex(member)) {
          // Element access must already be lowered to bounds-checked intrinsics.
          continue;
        }
        ctx.fail(member, "CR305", "unsupported record field or index signature");
      }
      const fields = properties.map(prop => {
        const key = prop.name;
        if (!key || !ts.isIdentifier(key)) return ctx.fail(prop, "CR306", "computed native record property");
        const type = ctx.type(prop.type ?? null, prop);
        return { name: cIdentifier(key.text), type };
      });
      if (fields.some(field => structs.some(other => other.name === field.type) && !available.has(field.type))) {
        continue;
      }
      text.push("struct " + item.name + " {");
      // Opaque allocation identity is part of the native intrinsic representation.
      if (item.name === "__bake_c_Buffer" && fields.some(field => field.name === "handle"))
        ctx.fail(item.declaration, "CR310", "native buffer handle is reserved by the backend");
      if (item.name === "__bake_c_Buffer") text.push("  uint64_t handle;");
      for (const field of fields) text.push("  " + field.type + " " + field.name + ";");
      if (!fields.length) text.push("  unsigned char _croissant_empty;");
      text.push("};", "");
      available.add(item.name);
      pending.splice(i, 1);
      advanced = true;
    }
    if (!advanced) throw new Error("CR307: recursive native interface by value");
  }

  const typeDefinitions = text.slice(1);

  // External intrinsic declarations are an ABI contract, never JS shims.
  for (const [name, decl] of externals) {
    const sig = emitter.functionSignature(decl, name);
    text.push((name === "__bake_c_abort_range" ? "__attribute__((noreturn)) " : "") + sig + ";");
  }
  text.push("");

  for (const item of globals) {
    const type = ctx.type(item.declaration.type ?? null, item.declaration.name);
    text.push(type + " " + item.name + ";");
  }
  text.push("");

  // Prototypes avoid implicit C declarations and support mutual recursion.
  for (const item of functions) text.push(emitter.functionSignature(item.declaration, item.name) + ";");
  text.push("");

  text.push("void croissant_init_globals(void) {");
  for (const item of globals) {
    const type = ctx.type(item.declaration.type ?? null, item.declaration.name);
    const initializer = item.declaration.initializer ?? null;
    if (!initializer) return ctx.fail(item.declaration, "CR308", "uninitialised top-level native variable");
    text.push("  " + item.name + " = " + emitter.expression(initializer, type) + ";");
  }
  text.push("}", "");
  for (const item of functions) {
    if (!(item.declaration.body ?? null)) ctx.fail(item.declaration, "CR309", "missing native function body");
    text.push(emitter.function(item.declaration, item.name));
  }

  if ("outputDir" in request) {
    const project = emitProject({
      destination: request.outputDir, context: ctx, emitter,
      sources: sourceFiles, types: typeDefinitions, intrinsics: externals,
      globals, functions
    });
    return {
      files: files.length, functions: functions.length, globals: globals.length,
      interfaces: structs.length, outputPath: project.directory,
      generatedFiles: project.generatedFiles
    };
  }

  if (!("outputPath" in request) || !request.outputPath) throw new Error("CR000: missing output path");
  const outputPath = path.resolve(request.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  // Atomic publication ensures a failed compiler cannot leave a partial C file.
  const temp = outputPath + ".tmp";
  try {
    fs.writeFileSync(temp, text.join("\n"));
    fs.renameSync(temp, outputPath);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
  return { files: files.length, functions: functions.length, globals: globals.length,
    interfaces: structs.length, outputPath, generatedFiles: [] };
}

export { CompilerError };
