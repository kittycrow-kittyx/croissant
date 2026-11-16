#!/usr/bin/env node
import { compile, CompilerError } from "./compiler.js";

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const exact = args.indexOf(name);
  if (exact >= 0) return args[exact + 1];
  const prefix = args.find(arg => arg.startsWith(name + "="));
  return prefix?.slice(name.length + 1);
}
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write("Croissant compiler\\nUsage: croissant --manifest build/bake-clang/bake-manifest.json --out build/rei.c\\n");
  process.exit(0);
}
const manifestPath = option("--manifest");
const outputPath = option("--out");
if (!manifestPath || !outputPath || manifestPath.startsWith("--") || outputPath.startsWith("--")) {
  process.stderr.write("CR000: --manifest and --out are required. Run --help for usage.\\n");
  process.exit(2);
}
try {
  const result = compile({ manifestPath, outputPath });
  process.stdout.write("Croissant: emitted " + result.outputPath + " from " +
    result.files + " modules (" + result.functions + " functions, " +
    result.globals + " globals, " + result.interfaces + " records).\\n");
} catch (error) {
  process.stderr.write((error instanceof CompilerError || error instanceof Error
    ? error.message : String(error)) + "\\n");
  process.exitCode = 1;
}
