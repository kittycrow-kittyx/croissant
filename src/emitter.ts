import ts from "typescript";
import { Context, cIdentifier } from "./context.js";

const indent = (depth: number): string => "  ".repeat(depth);
const condition = (value: string): string => value.startsWith("(") && value.endsWith(")") ? value : "(" + value + ")";
const op = (kind: ts.SyntaxKind): string => {
  const name = ts.tokenToString(kind) ?? null;
  if (!name) throw new Error("Unknown operator: " + ts.SyntaxKind[kind]);
  if (name === "===") return "==";
  if (name === "!==") return "!=";
  return name;
};

function numericLiteral(text: string): string {
  const literal = text.replaceAll("_", "");
  // TypeScript numeric literals are IEEE-754 doubles, not arbitrary-sized C integers.
  return /^[0-9]+$/.test(literal) && literal.length >= 16 ? literal + ".0" : literal;
}

export class Emitter {
  constructor(readonly ctx: Context) {}

  private binary(node: ts.BinaryExpression): string {
    // JavaScript bitwise operations coerce to i32, unlike ordinary floating-point arithmetic.
    const f = (expr: ts.Expression, type: string | null = null): string => this.expression(expr, type);
    const kind = node.operatorToken.kind;
    if (kind === ts.SyntaxKind.AsteriskAsteriskToken) {
      return this.ctx.fail(node, "CR203", "exponentiation needs a typed intrinsic");
    }
    if (kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
      return "croissant_js_ushr(" + f(node.left) + ", " + f(node.right) + ")";
    }
    if (kind === ts.SyntaxKind.QuestionQuestionToken) return this.ctx.fail(node, "CR204", "nullish operator survived Bake");
    const numeric = this.ctx.program.getTypeChecker().getTypeAtLocation(ts.getOriginalNode(node.left));
    const isBig = (numeric.flags & ts.TypeFlags.BigIntLike) !== 0;
    const compoundOp: Partial<Record<ts.SyntaxKind, string>> = {
      [ts.SyntaxKind.AmpersandEqualsToken]: "croissant_js_and",
      [ts.SyntaxKind.BarEqualsToken]: "croissant_js_or",
      [ts.SyntaxKind.CaretEqualsToken]: "croissant_js_xor",
      [ts.SyntaxKind.LessThanLessThanEqualsToken]: "croissant_js_shl",
      [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: "croissant_js_shr",
      [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: "croissant_js_ushr"
    };
    const compound = isBig ? null : compoundOp[kind] ?? null;
    if (compound && !ts.isIdentifier(node.left)) return this.ctx.fail(node, "CR204", "bitwise compound assignment requires a stable identifier");
    if (compound) {
      const left = f(node.left);
      return "(" + left + " = " + compound + "(" + left + ", " + f(node.right) + "))";
    }
    const nativeOp: Partial<Record<ts.SyntaxKind, string>> = {
        [ts.SyntaxKind.AmpersandToken]: "croissant_js_and",
        [ts.SyntaxKind.BarToken]: "croissant_js_or",
        [ts.SyntaxKind.CaretToken]: "croissant_js_xor",
        [ts.SyntaxKind.LessThanLessThanToken]: "croissant_js_shl",
        [ts.SyntaxKind.GreaterThanGreaterThanToken]: "croissant_js_shr",
        [ts.SyntaxKind.PercentToken]: "croissant_js_remainder"
      };
    const intrinsic = isBig ? null : nativeOp[kind] ?? null;
    if (intrinsic) return intrinsic + "(" + f(node.left) + ", " + f(node.right) + ")";
    if (kind === ts.SyntaxKind.CommaToken) return "(" + f(node.left) + ", " + f(node.right) + ")";
    return "(" + f(node.left) + " " + op(kind) + " " + f(node.right) + ")";
  }

  private prefix(node: ts.PrefixUnaryExpression): string {
    const f = (expr: ts.Expression, type: string | null = null): string => this.expression(expr, type);
    const operator = op(node.operator);
    if (node.operator === ts.SyntaxKind.MinusToken && ts.isBigIntLiteral(node.operand)) {
      const literal = node.operand.text.slice(0, -1).replaceAll("_", "");
      return "(-INT64_C(" + literal + "))";
    }
    if (node.operator === ts.SyntaxKind.TildeToken) {
      const type = this.ctx.program.getTypeChecker().getTypeAtLocation(ts.getOriginalNode(node.operand));
      return (type.flags & ts.TypeFlags.BigIntLike) ? "(~" + f(node.operand) + ")"
        : "croissant_js_not(" + f(node.operand) + ")";
    }
    return "(" + operator + f(node.operand) + ")";
  }

  private appendDefaults(node: ts.CallExpression, args: string[], parameters: readonly (ts.ParameterDeclaration | ts.JSDocParameterTag)[]): void {
    for (const parameter of parameters.slice(args.length)) {
      if (!ts.isParameter(parameter)) this.ctx.fail(node, "CR209", "JSDoc parameter requires a typed declaration");
      const initial = parameter.initializer ?? null;
      if (initial) { args.push(this.expression(initial)); continue; }
      if (parameter.questionToken ?? null) this.ctx.fail(node, "CR207", "optional arguments need an explicit C sentinel");
      this.ctx.fail(node, "CR208", "missing required argument");
    }
  }

  private call(node: ts.CallExpression): string {
    const f = (expr: ts.Expression, type: string | null = null): string => this.expression(expr, type);
    if ((node.typeArguments ?? []).length) return this.ctx.fail(node, "CR206", "generic runtime function call");
    const args = node.arguments.map(a => f(a));
    const checker = this.ctx.program.getTypeChecker();
    const signature = checker.getResolvedSignature(node) ?? null;
    const decl = signature ? signature.declaration ?? null : null;
    if (decl && "parameters" in decl) this.appendDefaults(node, args, decl.parameters);
    return f(node.expression) + "(" + args.join(", ") + ")";
  }

  private field(property: ts.ObjectLiteralElementLike): string {
    if (ts.isPropertyAssignment(property) && !ts.isIdentifier(property.name)) return this.ctx.fail(property, "CR209", "computed object field");
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) return "." + cIdentifier(property.name.text) + " = " + this.expression(property.initializer);
    if (ts.isShorthandPropertyAssignment(property)) return "." + cIdentifier(property.name.text) + " = " + this.expression(property.name);
    return this.ctx.fail(property, "CR210", "unsupported object construction");
  }

  private object(node: ts.ObjectLiteralExpression, expected: string | null = null): string {
    const type = expected ?? this.ctx.type(null, node);
    const fields = node.properties.map(property => this.field(property));
    return "(" + type + "){ " + fields.join(", ") + " }";
  }

  expression(node: ts.Expression, expected: string | null = null): string {
    // Preserve explicit casts and literal widths; delegate compound expressions to their typed emitters.
    const f = (expr: ts.Expression, type: string | null = null): string => this.expression(expr, type);
    if (ts.isIdentifier(node) && node.text === "undefined") return this.ctx.fail(node, "CR201", "undefined has no freestanding C value");
    if (ts.isIdentifier(node)) return this.ctx.ident(node);
    if (ts.isNumericLiteral(node)) return numericLiteral(node.text);
    if (ts.isBigIntLiteral(node)) {
      const body = node.text.slice(0, -1).replaceAll("_", "");
      return "UINT64_C(" + body + ")";
    }
    if (ts.isStringLiteral(node)) return JSON.stringify(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return "true";
    if (node.kind === ts.SyntaxKind.FalseKeyword) return "false";
    if (node.kind === ts.SyntaxKind.NullKeyword) return this.ctx.fail(node, "CR202", "null needs a typed optional representation");
    if (ts.isParenthesizedExpression(node)) return "(" + f(node.expression, expected) + ")";
    if (ts.isNonNullExpression(node) || ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
      return f(node.expression, expected);
    }
    if (ts.isBinaryExpression(node)) return this.binary(node);
    if (ts.isPrefixUnaryExpression(node)) return this.prefix(node);
    if (ts.isPostfixUnaryExpression(node)) {
      return "(" + f(node.operand) + op(node.operator) + ")";
    }
    if (ts.isConditionalExpression(node)) {
      return "(" + f(node.condition) + " ? " + f(node.whenTrue, expected) +
        " : " + f(node.whenFalse, expected) + ")";
    }
    if (ts.isPropertyAccessExpression(node)) {
      return "(" + f(node.expression) + ")." + cIdentifier(node.name.text);
    }
    if (ts.isElementAccessExpression(node)) {
      return this.ctx.fail(node, "CR205", "unlowered indexed access requires a native C intrinsic");
    }
    if (ts.isCallExpression(node)) return this.call(node);
    if (ts.isObjectLiteralExpression(node)) return this.object(node, expected);
    if (ts.isArrayLiteralExpression(node)) return this.ctx.fail(node, "CR211", "unlowered array construction");
    if (ts.isTemplateExpression(node) || ts.isTaggedTemplateExpression(node)) {
      return this.ctx.fail(node, "CR212", "dynamic JavaScript template expression");
    }
    return this.ctx.fail(node, "CR213", "unsupported expression " + ts.SyntaxKind[node.kind]);
  }

  private forInitial(node: ts.ForStatement): string {
    const init = node.initializer ?? null;
    if (!init) return "";
    if (!ts.isVariableDeclarationList(init)) return this.expression(init);
    const decl = init.declarations[0] ?? null;
    if (init.declarations.length !== 1 || !decl) return this.ctx.fail(node, "CR216", "multiple C for-loop declarations");
    const initial = decl.initializer ?? null;
    if (!ts.isIdentifier(decl.name) || !initial) return this.ctx.fail(decl, "CR217", "unsupported for-loop binding");
    return this.ctx.type(decl.type ?? null, decl.name) + " " + decl.name.text + " = " + this.expression(initial);
  }

  statement(node: ts.Statement, depth: number, returnType: string): string {
    // Scoped blocks preserve declaration visibility and avoid changing loop or branch lifetimes.
    const pre = indent(depth);
    const f = (e: ts.Expression, expected: string | null = null): string => this.expression(e, expected);
    const s = (n: ts.Statement, level: number): string => this.statement(n, level, returnType);
    if (ts.isBlock(node)) {
      return "{\n" + node.statements.map(stmt => s(stmt, depth + 1)).join("") + pre + "}";
    }
    if (ts.isVariableStatement(node)) {
      return node.declarationList.declarations.map(decl => {
        if (!ts.isIdentifier(decl.name)) return this.ctx.fail(decl, "CR214", "destructuring survived Bake");
        const type = this.ctx.type(decl.type ?? null, decl.name);
        const initial = decl.initializer ?? null;
        if (!initial) return pre + type + " " + decl.name.text + ";\n";
        return pre + type + " " + cIdentifier(decl.name.text) + " = " + f(initial, type) + ";\n";
      }).join("");
    }
    if (ts.isReturnStatement(node)) {
      const value = node.expression ?? null;
      return pre + (value ? "return " + f(value, returnType) : "return") + ";\n";
    }
    if (ts.isIfStatement(node)) {
      const yes = ts.isBlock(node.thenStatement) ? s(node.thenStatement, depth) :
        "{\n" + s(node.thenStatement, depth + 1) + pre + "}";
      const alternate = node.elseStatement ?? null;
      const no = alternate
        ? " else " + (ts.isBlock(alternate) ? s(alternate, depth) :
            "{\n" + s(alternate, depth + 1) + pre + "}") : "";
      return pre + "if " + condition(f(node.expression)) + " " + yes + no + "\n";
    }
    if (ts.isWhileStatement(node)) {
      return pre + "while " + condition(f(node.expression)) + " " + (ts.isBlock(node.statement)
        ? s(node.statement, depth) : "{\n" + s(node.statement, depth + 1) + pre + "}") + "\n";
    }
    if (ts.isDoStatement(node)) {
      return pre + "do " + (ts.isBlock(node.statement) ? s(node.statement, depth)
        : "{\n" + s(node.statement, depth + 1) + pre + "}") +
        " while (" + f(node.expression) + ");\n";
    }
    if (ts.isForStatement(node)) {
      const initial = this.forInitial(node);
      const conditionNode = node.condition ?? null;
      const cond = conditionNode ? f(conditionNode) : "true";
      const increment = node.incrementor ?? null;
      const step = increment ? f(increment) : "";
      return pre + "for (" + initial + "; " + cond + "; " + step + ") " +
        (ts.isBlock(node.statement) ? s(node.statement, depth) :
          "{\n" + s(node.statement, depth + 1) + pre + "}") + "\n";
    }
    if (ts.isSwitchStatement(node)) {
      let body = pre + "switch (" + f(node.expression) + ") {\n";
      for (const clause of node.caseBlock.clauses) {
        body += indent(depth + 1) + (ts.isDefaultClause(clause)
          ? "default:" : "case " + f(clause.expression) + ":") + "\n";
        for (const entry of clause.statements) body += s(entry, depth + 2);
      }
      return body + pre + "}\n";
    }
    if (ts.isBreakStatement(node)) return pre + "break;\n";
    if (ts.isContinueStatement(node)) return pre + "continue;\n";
    if (ts.isExpressionStatement(node)) return pre + f(node.expression) + ";\n";
    if (ts.isEmptyStatement(node)) return pre + ";\n";
    return this.ctx.fail(node, "CR218", "unsupported statement " + ts.SyntaxKind[node.kind]);
  }

  functionSignature(node: ts.FunctionDeclaration, name: string): string {
    if (!(node.name ?? null)) return this.ctx.fail(node, "CR219", "anonymous top-level function");
    if ((node.typeParameters ?? []).length) return this.ctx.fail(node, "CR220", "generic native function");
    const returns = this.ctx.type(node.type ?? null, node);
    const params = node.parameters.map(param => {
      if (!ts.isIdentifier(param.name) || (param.dotDotDotToken ?? null)) {
        return this.ctx.fail(param, "CR221", "unsupported native function parameter");
      }
      return this.ctx.type(param.type ?? null, param.name) + " " + cIdentifier(param.name.text);
    });
    return returns + " " + name + "(" + (params.length ? params.join(", ") : "void") + ")";
  }

  function(node: ts.FunctionDeclaration, name: string): string {
    const signature = this.functionSignature(node, name);
    const body = node.body ?? null;
    if (!body) return "";
    return signature + " " + this.statement(body, 0, this.ctx.type(node.type ?? null, node)) + "\n\n";
  }
}
