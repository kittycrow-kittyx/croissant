#!/usr/bin/env node
import { compile, CompilerError } from "./compiler.js";

const args = process.argv.slice(2);
function option(name: string): string | null {
  const exact = args.indexOf(name);
  if (exact >= 0) return args[exact + 1] ?? null;
  const prefix = args.find(arg => arg.startsWith(name + "="));
  return prefix?.slice(name.length + 1) ?? null;
}
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write("Croissant compiler\nUsage: croissant --manifest build/bake-clang/bake-manifest.json --out-dir build/rei\nLegacy: --out build/rei.c\n");
  process.exit(0);
}
const manifestPath = option("--manifest");
const outputPath = option("--out");
const outputDir = option("--out-dir");
if (!manifestPath || manifestPath.startsWith("--") ||
    Boolean(outputPath) === Boolean(outputDir) ||
    outputPath?.startsWith("--") || outputDir?.startsWith("--")) {
  process.stderr.write("CR000: provide --manifest and exactly one of --out-dir or --out.\n");
  process.exit(2);
}
try {
  const result = compile({ manifestPath, ...(outputPath ? { outputPath } : outputDir ? { outputDir } : {}) });
  process.stdout.write("Croissant: emitted " + (result.generatedFiles ?
    `${result.generatedFiles.length} structured files in ` : "") + result.outputPath + " from " +
    result.files + " modules (" + result.functions + " functions, " +
    result.globals + " globals, " + result.interfaces + " records).\n");
} catch (error) {
  process.stderr.write((error instanceof CompilerError || error instanceof Error
    ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
