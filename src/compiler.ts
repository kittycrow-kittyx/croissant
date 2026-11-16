import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { CompilerError, Context } from "./context.js";
import { Emitter } from "./emitter.js";

export interface CompileRequest {
  readonly manifestPath: string;
  readonly outputPath: string;
}

export interface CompileResult {
  readonly files: number;
  readonly functions: number;
  readonly globals: number;
  readonly interfaces: number;
  readonly outputPath: string;
}

type Manifest = {
  target?: { backend?: string; intrinsicAbi?: number; freestanding?: boolean };
  sourceFiles?: string[];
};

const header = [
  "/* Croissant: generated from Bake --target=clang. Do not edit. */",
  "/* Platform must implement the declared __bake_c_* ABI. */",
  "#include <stdint.h>",
  "#include <stdbool.h>",
  "#include <stddef.h>",
  ""
].join("\n");

export function compile(request: CompileRequest): CompileResult {
  const manifestPath = path.resolve(request.manifestPath);
  const root = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  if (manifest.target?.backend !== "clang" || manifest.target?.freestanding !== true) {
    throw new Error("CR001: input must be Bake --target=clang freestanding output");
  }
  if (!manifest.sourceFiles?.length) throw new Error("CR002: Bake manifest has no source files");
  if (manifest.target.intrinsicAbi !== undefined && manifest.target.intrinsicAbi !== 1) {
    throw new Error("CR003: unsupported Bake native intrinsic ABI");
  }

  const files = manifest.sourceFiles.map(relative => {
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
  if (diagnostics.length) {
    const d = diagnostics[0]!;
    const file = d.file?.fileName ?? "<typescript>";
    const at = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
    throw new Error("CR006: Bake output failed TypeScript checking (" + diagnostics.length + " errors). " +
      path.relative(root, file) + ":" + at + ": " + ts.flattenDiagnosticMessageText(d.messageText, " "));
  }

  const ctx = new Context(program, root);
  const sourceFiles = files.map(file => program.getSourceFile(file)!);
  const globals: Array<{ name: string; declaration: ts.VariableDeclaration }> = [];
  const functions: Array<{ name: string; declaration: ts.FunctionDeclaration }> = [];
  const structs: Array<{ name: string; declaration: ts.InterfaceDeclaration }> = [];
  const externals = new Map<string, ts.FunctionDeclaration>();

  // Register all global symbols before compiling bodies, including imports
  // and calls referencing declarations in a different TypeScript module.
  for (const source of sourceFiles) {
    for (const statement of source.statements) {
      if (ts.isInterfaceDeclaration(statement)) {
        const name = statement.name.text.startsWith("__bake_c_")
          ? statement.name.text : ctx.module(source) + "__" + statement.name.text;
        ctx.register(statement.name, name);
        if (!structs.some(entry => entry.name === name)) {
          structs.push({ name, declaration: statement });
        }
      } else if (ts.isFunctionDeclaration(statement) && statement.name) {
        const name = statement.name.text.startsWith("__bake_c_")
          ? statement.name.text : ctx.module(source) + "__" + statement.name.text;
        ctx.register(statement.name, name);
        if (name.startsWith("__bake_c_")) {
          if (statement.body) ctx.fail(statement, "CR301", "compiler intrinsic must be external");
          if (!externals.has(name)) externals.set(name, statement);
        } else functions.push({ name, declaration: statement });
      } else if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          const id = decl.name;
          if (!ts.isIdentifier(id)) return ctx.fail(decl, "CR302", "top-level destructuring unsupported");
          const name = ctx.module(source) + "__" + id.text;
          ctx.register(id, name);
          globals.push({ name, declaration: decl });
        }
      } else if (ts.isTypeAliasDeclaration(statement) ||
                 ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ||
                 ts.isEmptyStatement(statement)) {
        // Erased type imports/exports and scalar aliases are compile-time only.
      } else {
        ctx.fail(statement, "CR303", "unsupported module declaration " + ts.SyntaxKind[statement.kind]);
      }
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
      const item = pending[i]!;
      const properties = item.declaration.members.filter(ts.isPropertySignature);
      if (properties.length !== item.declaration.members.length) {
        ctx.fail(item.declaration, "CR305", "only fixed record properties are supported");
      }
      const fields = properties.map(prop => {
        const key = prop.name;
        if (!key || !ts.isIdentifier(key)) return ctx.fail(prop, "CR306", "computed native record property");
        const type = ctx.type(prop.type, prop);
        return { name: key.text, type };
      });
      if (fields.some(field => structs.some(other => other.name === field.type) && !available.has(field.type))) {
        continue;
      }
      text.push("struct " + item.name + " {");
      for (const field of fields) text.push("  " + field.type + " " + field.name + ";");
      if (!fields.length) text.push("  unsigned char _croissant_empty;");
      text.push("};", "");
      available.add(item.name);
      pending.splice(i, 1);
      advanced = true;
    }
    if (!advanced) throw new Error("CR307: recursive native interface by value");
  }

  // External intrinsic declarations are an ABI contract, never JS shims.
  for (const [name, decl] of externals) {
    const sig = emitter.functionSignature(decl, name);
    text.push((name === "__bake_c_abort_range" ? "__attribute__((noreturn)) " : "") + sig + ";");
  }
  text.push("");

  for (const item of globals) {
    const type = ctx.type(item.declaration.type, item.declaration.name);
    text.push(type + " " + item.name + ";");
  }
  text.push("");

  // Prototypes avoid implicit C declarations and support mutual recursion.
  for (const item of functions) text.push(emitter.functionSignature(item.declaration, item.name) + ";");
  text.push("");

  text.push("void croissant_init_globals(void) {");
  for (const item of globals) {
    const type = ctx.type(item.declaration.type, item.declaration.name);
    const initializer = item.declaration.initializer;
    if (!initializer) return ctx.fail(item.declaration, "CR308", "uninitialised top-level native variable");
    text.push("  " + item.name + " = " + emitter.expression(initializer, type) + ";");
  }
  text.push("}", "");
  for (const item of functions) {
    if (!item.declaration.body) ctx.fail(item.declaration, "CR309", "missing native function body");
    text.push(emitter.function(item.declaration, item.name));
  }

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
    interfaces: structs.length, outputPath };
}

export { CompilerError };
