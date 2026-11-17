import ts from "typescript";
import path from "node:path";

export class CompilerError extends Error {
  constructor(readonly code: string, readonly file: string, readonly line: number, message: string) {
    super(code + " " + file + ":" + line + ": " + message);
  }
}

const SCALARS: Readonly<Record<string, string>> = {
  I32: "int32_t", U32: "uint32_t", Ptr: "uint32_t",
  I64: "int64_t", U64: "uint64_t", F32: "float", F64: "double",
  number: "double", bigint: "uint64_t", boolean: "bool",
  void: "void", never: "void", string: "const char *",
  undefined: "void", null: "void"
};

const C_KEYWORDS = new Set([
  "auto", "break", "case", "char", "const", "continue", "default", "do",
  "double", "else", "enum", "extern", "float", "for", "goto", "if",
  "inline", "int", "long", "register", "restrict", "return", "short",
  "signed", "sizeof", "static", "struct", "switch", "typedef", "union",
  "unsigned", "void", "volatile", "while", "_Bool", "_Atomic", "_Generic"
]);

export function cIdentifier(name: string): string {
  return C_KEYWORDS.has(name) ? "croissant_" + name : name;
}

export class Context {
  readonly symbols = new Map<ts.Symbol, string>();
  readonly structs = new Map<string, ts.InterfaceDeclaration>();
  readonly functions = new Map<string, ts.FunctionDeclaration>();
  readonly globals = new Map<string, ts.VariableDeclaration>();
  readonly intrinsics = new Map<string, ts.FunctionDeclaration>();
  readonly modulePaths = new Map<string, string>();

  constructor(readonly program: ts.Program, readonly root: string) {}

  fail(node: ts.Node, code: string, message: string): never {
    const source = node.getSourceFile();
    const location = source && node.pos >= 0
      ? source.getLineAndCharacterOfPosition(node.getStart(source)) : { line: 0 };
    const file = source ? path.relative(this.root, source.fileName).split(path.sep).join("/") : "<synthetic>";
    throw new CompilerError(code, file, location.line + 1, message);
  }

  module(file: ts.SourceFile): string {
    const rel = path.relative(this.root, file.fileName).replaceAll("\\", "/").replace(/\\.ts$/, "");
    return "croissant_" + rel.replace(/[^A-Za-z0-9_]/g, "_");
  }

  ident(name: ts.Identifier): string {
    if (name.text.startsWith("__bake_c_")) return name.text;
    const checker = this.program.getTypeChecker();
    let symbol = checker.getSymbolAtLocation(name);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    if (symbol && this.symbols.has(symbol)) return this.symbols.get(symbol)!;
    return cIdentifier(name.text);
  }

  register(name: ts.Identifier, cName: string): void {
    const checker = this.program.getTypeChecker();
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol && this.symbols.has(symbol) && this.symbols.get(symbol) !== cName) {
      this.fail(name, "CR101", "symbol collision: " + name.text);
    }
    if (symbol) this.symbols.set(symbol, cName);
  }

  type(node: ts.TypeNode | undefined, origin?: ts.Node): string {
    if (!node) {
      if (origin) {
        const type = this.program.getTypeChecker().getTypeAtLocation(origin);
        const alias = type.aliasSymbol?.getName();
        if (alias && SCALARS[alias]) return SCALARS[alias]!;
        const flags = type.flags;
        if (flags & ts.TypeFlags.BooleanLike) return "bool";
        if (flags & ts.TypeFlags.BigIntLike) return "uint64_t";
        if (flags & ts.TypeFlags.NumberLike) return "double";
        if (flags & ts.TypeFlags.Void) return "void";
        if (flags & ts.TypeFlags.StringLike) return "const char *";
        const symbol = type.symbol;
        if (symbol && this.symbols.has(symbol)) return this.symbols.get(symbol)!;
      }
      this.fail(origin ?? this.program.getSourceFiles()[0]!, "CR102", "unresolved C type: add a static TypeScript annotation");
    }
    if (ts.isParenthesizedTypeNode(node)) return this.type(node.type, origin);
    if (ts.isTypeReferenceNode(node)) {
      if (!ts.isIdentifier(node.typeName)) this.fail(node, "CR103", "qualified type references are unsupported");
      const name = node.typeName.text;
      if (SCALARS[name]) return SCALARS[name]!;
      if (name === "ArrayBufferLike" || name === "ArrayBuffer" || name === "SharedArrayBuffer") return "__bake_c_Buffer";
      const checker = this.program.getTypeChecker();
      let symbol = checker.getSymbolAtLocation(node.typeName);
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
      if (symbol && this.symbols.has(symbol)) return this.symbols.get(symbol)!;
      this.fail(node, "CR104", "unknown user-defined type " + name);
    }
    if (ts.isUnionTypeNode(node)) {
      const choices = node.types.map(part => this.type(part, origin));
      const unique = [...new Set(choices)];
      if (unique.length === 1) return unique[0]!;
      if (unique.every(type => ["uint32_t", "int32_t", "uint64_t", "int64_t", "double", "float"].includes(type))) {
        if (unique.includes("double") || unique.includes("float")) return "double";
        // A mixed signed/unsigned 32-bit domain needs all 33 value bits.
        // Choosing uint32_t changes negative values before widening.
        if (unique.length === 2 && unique.includes("int32_t") && unique.includes("uint32_t")) return "int64_t";
        return unique.includes("uint64_t") ? "uint64_t" : unique.includes("int64_t") ? "int64_t" :
          unique.includes("uint32_t") ? "uint32_t" : "int32_t";
      }
      this.fail(node, "CR105", "union requires a tagged C representation: " + unique.join(" | "));
    }
    if (node.kind === ts.SyntaxKind.NumberKeyword) return "double";
    if (node.kind === ts.SyntaxKind.BigIntKeyword) return "uint64_t";
    if (node.kind === ts.SyntaxKind.BooleanKeyword) return "bool";
    if (node.kind === ts.SyntaxKind.VoidKeyword || node.kind === ts.SyntaxKind.NeverKeyword) return "void";
    if (node.kind === ts.SyntaxKind.StringKeyword) return "const char *";
    if (ts.isArrayTypeNode(node)) this.fail(node, "CR106", "arrays require explicit native view types");
    if (ts.isLiteralTypeNode(node)) {
      if (ts.isNumericLiteral(node.literal)) return "double";
      if (ts.isBigIntLiteral(node.literal)) return "uint64_t";
      if (node.literal.kind === ts.SyntaxKind.TrueKeyword || node.literal.kind === ts.SyntaxKind.FalseKeyword) return "bool";
    }
    return this.fail(node, "CR107", "unsupported TypeScript type " + ts.SyntaxKind[node.kind]);
  }
}
