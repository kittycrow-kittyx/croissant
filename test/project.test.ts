import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/compiler.js";

function fixture(): { root: string; manifest: string; output: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "croissant-project-"));
  fs.mkdirSync(path.join(root, "core"), { recursive: true });
  fs.mkdirSync(path.join(root, "native"), { recursive: true });
  fs.writeFileSync(path.join(root, "core/arithmetic.ts"), [
    "export function sum(n: number): number {",
    "  let value: number = 0;",
    "  for (let i: number = 0; i < n; i++) value += i;",
    "  return value;",
    "}"
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(root, "native/kernel.ts"), [
    'import { sum } from "../core/arithmetic.js";',
    "export type U64 = bigint;",
    "export interface State { pc: U64; hart: number; }",
    "declare function __bake_c_bigint(value: number): bigint;",
    "export const BASE: U64 = 0x1000n;",
    "export function initialise(hart: number): State {",
    "  return { pc: BASE, hart };",
    "}",
    "export function step(state: State, count: number): U64 {",
    "  return state.pc + __bake_c_bigint(sum(count));",
    "}"
  ].join("\n") + "\n");
  const manifest = path.join(root, "bake-manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({
    target: { backend: "clang", freestanding: true, intrinsicAbi: 1 },
    sourceFiles: ["core/arithmetic.ts", "native/kernel.ts"]
  }));
  return { root, manifest, output: path.join(os.tmpdir(), "croissant-generated-" + path.basename(root)) };
}

test("modular project has separate modules, usable headers and linkable objects", () => {
  const { root, manifest, output } = fixture();
  try {
    const result = compile({ manifestPath: manifest, outputDir: output });
    assert.equal(result.files, 2);
    assert.ok((result.generatedFiles.length) >= 11);
    const paths = [
      "src/core/arithmetic.c", "src/native/kernel.c", "src/globals.c",
      "include/croissant/core/arithmetic.h", "include/croissant/native/kernel.h",
      "include/croissant/types.h", "include/croissant/intrinsics.h",
      "include/croissant/globals.h", "include/croissant/all.h",
      "CMakeLists.txt", "croissant.manifest.json"
    ];
    for (const file of paths) assert.ok(fs.existsSync(path.join(output, file)), file);
    assert.equal(fs.existsSync(path.join(output, "rei.c")), false);
    const native = fs.readFileSync(path.join(output, "src/native/kernel.c"), "utf8");
    const arithmetic = fs.readFileSync(path.join(output, "src/core/arithmetic.c"), "utf8");
    assert.match(native, /croissant_native_kernel_ts__step/);
    assert.doesNotMatch(arithmetic, /croissant_native_kernel_ts__step/);
    assert.match(arithmetic, /croissant_core_arithmetic_ts__sum/);
    const projects = readProject(fs.readFileSync(path.join(output, "croissant.manifest.json"), "utf8"));
    assert.equal(projects.modules.length, 2);
    for (const mod of projects.modules) {
      assert.ok(fs.existsSync(path.join(output, mod.source)));
      assert.ok(fs.existsSync(path.join(output, mod.header)));
    }
    const harness = path.join(output, "smoke.c");
    const executable = path.join(output, "smoke");
    fs.writeFileSync(harness, [
      '#include "croissant/all.h"',
      "uint64_t __bake_c_bigint(double value) { return (uint64_t)value; }",
      "int main(void) {",
      "  croissant_init_globals();",
      "  croissant_native_kernel_ts__State state = croissant_native_kernel_ts__initialise(2);",
      "  return croissant_native_kernel_ts__step(state, 6) == UINT64_C(0x100f) ? 0 : 1;",
      "}"
    ].join("\n") + "\n");
    const sources = ["src/globals.c", "src/core/arithmetic.c", "src/native/kernel.c"]
      .map(f => path.join(output, f));
    const clang = spawnSync("clang", [
      "-std=c11", "-O1", "-Wall", "-Werror", "-I" + path.join(output, "include"),
      ...sources, harness, "-o", executable
    ], { encoding: "utf8" });
    if (missingCommand(clang.error ?? null)) return;
    assert.equal(clang.status, 0, clang.stderr);
    const run = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test("modular output leaves previously published tree untouched when compilation fails", () => {
  const { root, manifest, output } = fixture();
  try {
    compile({ manifestPath: manifest, outputDir: output });
    const marker = path.join(output, "marker.txt");
    fs.writeFileSync(marker, "keep");
    fs.writeFileSync(path.join(root, "native/kernel.ts"),
      "export function invalid() { return [1, 2, 3]; }\n");
    assert.throws(() => compile({ manifestPath: manifest, outputDir: output }), /CR211|CR106/);
    assert.equal(fs.readFileSync(marker, "utf8"), "keep");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(output, { recursive: true, force: true });
  }
});

function missingCommand(error: Error | null): boolean {
  return error !== null && "code" in error && error.code === "ENOENT";
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const decode: (text: string) => Json = JSON.parse;
function readProject(text: string): { modules: { source: string; header: string }[] } {
  const value = decode(text);
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const modules = value.modules ?? null;
  assert.ok(Array.isArray(modules));
  return { modules: modules.map((entry: Json) => {
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry));
    const source = entry.source ?? null, header = entry.header ?? null;
    assert.equal(typeof source, "string"); assert.equal(typeof header, "string");
    if (typeof source !== "string" || typeof header !== "string") throw new Error("Invalid module manifest");
    return { source, header };
  }) };
}
