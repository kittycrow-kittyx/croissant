import ts from "typescript";
import { Context } from "./context.js";

const indent = (depth: number): string => "  ".repeat(depth);
const op = (kind: ts.SyntaxKind): string => {
  const name = ts.tokenToString(kind);
  if (!name) throw new Error("Unknown operator: " + ts.SyntaxKind[kind]);
  if (name === "===") return "==";
  if (name === "!==") return "!=";
  return name;
};

export class Emitter {
  constructor(readonly ctx: Context) {}

  expression(node: ts.Expression, expected?: string): string {
    const f = (expr: ts.Expression, type?: string): string => this.expression(expr, type);
    if (ts.isIdentifier(node)) {
      if (node.text === "undefined") return this.ctx.fail(node, "CR201", "undefined has no freestanding C value");
      return this.ctx.ident(node);
    }
    if (ts.isNumericLiteral(node)) return node.text.replaceAll("_", "");
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
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (kind === ts.SyntaxKind.AsteriskAsteriskToken) {
        return this.ctx.fail(node, "CR203", "exponentiation needs a typed intrinsic");
      }
      if (kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
        return "((uint32_t)(" + f(node.left) + ") >> ((uint32_t)(" +
          f(node.right) + ") & 31U))";
      }
      if (kind === ts.SyntaxKind.QuestionQuestionToken) return this.ctx.fail(node, "CR204", "nullish operator survived Bake");
      if (kind === ts.SyntaxKind.CommaToken) return "(" + f(node.left) + ", " + f(node.right) + ")";
      return "(" + f(node.left) + " " + op(kind) + " " + f(node.right) + ")";
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const operator = op(node.operator);
      if (node.operator === ts.SyntaxKind.TildeToken) return "(~" + f(node.operand) + ")";
      return "(" + operator + f(node.operand) + ")";
    }
    if (ts.isPostfixUnaryExpression(node)) {
      return "(" + f(node.operand) + op(node.operator) + ")";
    }
    if (ts.isConditionalExpression(node)) {
      return "(" + f(node.condition) + " ? " + f(node.whenTrue, expected) +
        " : " + f(node.whenFalse, expected) + ")";
    }
    if (ts.isPropertyAccessExpression(node)) {
      return "(" + f(node.expression) + ")." + node.name.text;
    }
    if (ts.isElementAccessExpression(node)) {
      return this.ctx.fail(node, "CR205", "unlowered indexed access requires a native C intrinsic");
    }
    if (ts.isCallExpression(node)) {
      if (node.typeArguments?.length) return this.ctx.fail(node, "CR206", "generic runtime function call");
      const args = node.arguments.map(a => f(a));
      const checker = this.ctx.program.getTypeChecker();
      const signature = checker.getResolvedSignature(node);
      const decl = signature?.declaration;
      if (decl && ("parameters" in decl)) {
        for (let i = args.length; i < decl.parameters.length; i++) {
          const parameter = decl.parameters[i]!;
          if (!ts.isParameter(parameter)) return this.ctx.fail(node, "CR209", "JSDoc parameter requires a typed declaration");
          if (parameter.initializer) args.push(f(parameter.initializer));
          else if (parameter.questionToken) return this.ctx.fail(node, "CR207", "optional arguments need an explicit C sentinel");
          else return this.ctx.fail(node, "CR208", "missing required argument");
        }
      }
      return f(node.expression) + "(" + args.join(", ") + ")";
    }
    if (ts.isObjectLiteralExpression(node)) {
      const type = expected ?? this.ctx.type(undefined, node);
      const fields: string[] = [];
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          if (!ts.isIdentifier(property.name)) return this.ctx.fail(property, "CR209", "computed object field");
          fields.push("." + property.name.text + " = " + f(property.initializer));
        } else if (ts.isShorthandPropertyAssignment(property)) {
          fields.push("." + property.name.text + " = " + f(property.name));
        } else return this.ctx.fail(property, "CR210", "unsupported object construction");
      }
      return "(" + type + "){ " + fields.join(", ") + " }";
    }
    if (ts.isArrayLiteralExpression(node)) return this.ctx.fail(node, "CR211", "unlowered array construction");
    if (ts.isTemplateExpression(node) || ts.isTaggedTemplateExpression(node)) {
      return this.ctx.fail(node, "CR212", "dynamic JavaScript template expression");
    }
    return this.ctx.fail(node, "CR213", "unsupported expression " + ts.SyntaxKind[node.kind]);
  }

  statement(node: ts.Statement, depth: number, returnType: string): string {
    const pre = indent(depth);
    const f = (e: ts.Expression, expected?: string): string => this.expression(e, expected);
    const s = (n: ts.Statement, level: number): string => this.statement(n, level, returnType);
    if (ts.isBlock(node)) {
      return "{\n" + node.statements.map(stmt => s(stmt, depth + 1)).join("") + pre + "}";
    }
    if (ts.isVariableStatement(node)) {
      return node.declarationList.declarations.map(decl => {
        if (!ts.isIdentifier(decl.name)) return this.ctx.fail(decl, "CR214", "destructuring survived Bake");
        const type = this.ctx.type(decl.type, decl.name);
        if (!decl.initializer) return pre + type + " " + decl.name.text + ";\n";
        return pre + type + " " + decl.name.text + " = " + f(decl.initializer, type) + ";\n";
      }).join("");
    }
    if (ts.isReturnStatement(node)) {
      return pre + (node.expression ? "return " + f(node.expression, returnType) : "return") + ";\n";
    }
    if (ts.isIfStatement(node)) {
      const yes = ts.isBlock(node.thenStatement) ? s(node.thenStatement, depth) :
        "{\n" + s(node.thenStatement, depth + 1) + pre + "}";
      const no = node.elseStatement
        ? " else " + (ts.isBlock(node.elseStatement) ? s(node.elseStatement, depth) :
            "{\n" + s(node.elseStatement, depth + 1) + pre + "}") : "";
      return pre + "if (" + f(node.expression) + ") " + yes + no + "\n";
    }
    if (ts.isWhileStatement(node)) {
      return pre + "while (" + f(node.expression) + ") " + (ts.isBlock(node.statement)
        ? s(node.statement, depth) : "{\n" + s(node.statement, depth + 1) + pre + "}") + "\n";
    }
    if (ts.isDoStatement(node)) {
      return pre + "do " + (ts.isBlock(node.statement) ? s(node.statement, depth)
        : "{\n" + s(node.statement, depth + 1) + pre + "}") +
        " while (" + f(node.expression) + ");\n";
    }
    if (ts.isForStatement(node)) {
      let initial = "";
      if (node.initializer) {
        if (ts.isVariableDeclarationList(node.initializer)) {
          const declarations = node.initializer.declarations;
          if (declarations.length !== 1) return this.ctx.fail(node, "CR216", "multiple C for-loop declarations");
          const decl = declarations[0]!;
          if (!ts.isIdentifier(decl.name) || !decl.initializer) return this.ctx.fail(decl, "CR217", "unsupported for-loop binding");
          initial = this.ctx.type(decl.type, decl.name) + " " + decl.name.text +
            " = " + f(decl.initializer);
        } else initial = f(node.initializer);
      }
      const cond = node.condition ? f(node.condition) : "true";
      const step = node.incrementor ? f(node.incrementor) : "";
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
    if (!node.name) return this.ctx.fail(node, "CR219", "anonymous top-level function");
    if (node.typeParameters?.length) return this.ctx.fail(node, "CR220", "generic native function");
    const returns = this.ctx.type(node.type, node);
    const params = node.parameters.map(param => {
      if (!ts.isIdentifier(param.name) || param.dotDotDotToken) {
        return this.ctx.fail(param, "CR221", "unsupported native function parameter");
      }
      return this.ctx.type(param.type, param.name) + " " + param.name.text;
    });
    return returns + " " + name + "(" + (params.length ? params.join(", ") : "void") + ")";
  }

  function(node: ts.FunctionDeclaration, name: string): string {
    const signature = this.functionSignature(node, name);
    if (!node.body) return "";
    return signature + " " + this.statement(node.body, 0, this.ctx.type(node.type, node)) + "\n\n";
  }
}
