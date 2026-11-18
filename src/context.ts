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
    return (symbol ? this.symbols.get(symbol) : undefined) ?? cIdentifier(name.text);
  }

  register(name: ts.Identifier, cName: string): void {
    const checker = this.program.getTypeChecker();
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol && this.symbols.has(symbol) && this.symbols.get(symbol) !== cName) {
      this.fail(name, "CR101", "symbol collision: " + name.text);
    }
    if (symbol) this.symbols.set(symbol, cName);
  }

  private inferType(origin?: ts.Node): string {
    const node = origin ?? this.program.getSourceFiles()[0];
    if (!node) throw new CompilerError("CR102", "<project>", 1, "unresolved C type: no source files");
    const type = origin ? this.program.getTypeChecker().getTypeAtLocation(origin) : undefined;
    const alias = type?.aliasSymbol?.getName();
    const scalar = alias ? SCALARS[alias] : undefined;
    if (scalar) return scalar;
    const flags = type?.flags ?? 0;
    if (flags & ts.TypeFlags.BooleanLike) return "bool";
    if (flags & ts.TypeFlags.BigIntLike) return "uint64_t";
    if (flags & ts.TypeFlags.NumberLike) return "double";
    if (flags & ts.TypeFlags.Void) return "void";
    if (flags & ts.TypeFlags.StringLike) return "const char *";
    const symbol = type?.symbol;
    const registered = symbol ? this.symbols.get(symbol) : undefined;
    return registered ?? this.fail(node, "CR102", "unresolved C type: add a static TypeScript annotation");
  }

  private namedType(node: ts.TypeReferenceNode): string {
    if (!ts.isIdentifier(node.typeName)) return this.fail(node, "CR103", "qualified type references are unsupported");
    const name = node.typeName.text;
    const scalar = SCALARS[name];
    if (scalar) return scalar;
    if (name === "ArrayBufferLike" || name === "ArrayBuffer" || name === "SharedArrayBuffer") return "__bake_c_Buffer";
    const checker = this.program.getTypeChecker();
    let symbol = checker.getSymbolAtLocation(node.typeName);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
    const registered = symbol ? this.symbols.get(symbol) : undefined;
    return registered ?? this.fail(node, "CR104", "unknown user-defined type " + name);
  }

  private unionType(node: ts.UnionTypeNode, origin?: ts.Node): string {
    const types = [...new Set(node.types.map(part => this.type(part, origin)))];
    const first = types[0];
    if (types.length === 1 && first) return first;
    if (!types.every(type => ["uint32_t", "int32_t", "uint64_t", "int64_t", "double", "float"].includes(type)))
      return this.fail(node, "CR105", "union requires a tagged C representation: " + types.join(" | "));
    if (types.includes("double") || types.includes("float")) return "double";
    // Mixed signed and unsigned 32-bit values need 33 value bits before widening.
    if (types.length === 2 && types.includes("int32_t") && types.includes("uint32_t")) return "int64_t";
    return types.includes("uint64_t") ? "uint64_t" : types.includes("int64_t") ? "int64_t" :
      types.includes("uint32_t") ? "uint32_t" : "int32_t";
  }

  type(node: ts.TypeNode | undefined, origin?: ts.Node): string {
    if (!node) return this.inferType(origin);
    if (ts.isParenthesizedTypeNode(node)) return this.type(node.type, origin);
    if (ts.isTypeReferenceNode(node)) return this.namedType(node);
    if (ts.isUnionTypeNode(node)) return this.unionType(node, origin);
    if (node.kind === ts.SyntaxKind.NumberKeyword || ts.isLiteralTypeNode(node) && ts.isNumericLiteral(node.literal)) return "double";
    if (node.kind === ts.SyntaxKind.BigIntKeyword || ts.isLiteralTypeNode(node) && ts.isBigIntLiteral(node.literal)) return "uint64_t";
    if (node.kind === ts.SyntaxKind.BooleanKeyword || ts.isLiteralTypeNode(node) && (node.literal.kind === ts.SyntaxKind.TrueKeyword || node.literal.kind === ts.SyntaxKind.FalseKeyword)) return "bool";
    if (node.kind === ts.SyntaxKind.VoidKeyword || node.kind === ts.SyntaxKind.NeverKeyword) return "void";
    if (node.kind === ts.SyntaxKind.StringKeyword) return "const char *";
    if (ts.isArrayTypeNode(node)) return this.fail(node, "CR106", "arrays require explicit native view types");
    return this.fail(node, "CR107", "unsupported TypeScript type " + ts.SyntaxKind[node.kind]);
  }
}
