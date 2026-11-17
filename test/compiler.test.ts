import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/compiler.js";

const fixture = [
  "export type I32 = number;",
  "export type U32 = number;",
  "export type U64 = bigint;",
  "declare function __bake_c_bigint(value: number): bigint;",
  "export interface CpuState { readonly pc: U64; readonly hart: U32; }",
  "export const BASE: U64 = 0x1000n;",
  "export function add(left: U32, right: U32): U32 { return left + right; }",
  "export function initial(hart: U32): CpuState {",
  "  return { pc: BASE, hart };",
  "}",
  "export function step(cpu: CpuState, delta: U32): U64 {",
  "  let index: U32 = 0;",
  "  for (let i: U32 = 0; i < delta; i += 1) index += i;",
  "  if (index > 10) return cpu.pc + __bake_c_bigint(index);",
  "  return cpu.pc;",
  "}"
].join("\n");

function project(files: Record<string, string>): {
  root: string; manifestPath: string; out: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "croissant-"));
  for (const [file, source] of Object.entries(files)) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source);
  }
  const manifestPath = path.join(root, "bake-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    target: { backend: "clang", freestanding: true, intrinsicAbi: 1 },
    sourceFiles: Object.keys(files)
  }));
  return { root, manifestPath, out: path.join(root, "generated.c") };
}

test("compiles typed Bake subset to freestanding C for two architectures", () => {
  const { root, manifestPath, out } = project({ "native/kernel.ts": fixture });
  try {
    const result = compile({ manifestPath, outputPath: out });
    assert.equal(result.files, 1);
    assert.ok(result.functions >= 3);
    const generated = fs.readFileSync(out, "utf8");
    assert.match(generated, /struct croissant_native_kernel_ts__CpuState/);
    assert.match(generated, /void croissant_init_globals\(void\)/);
    assert.match(generated, /for \(/);
    assert.doesNotMatch(generated, /require\(|WebAssembly|node_modules/);
    const clang = spawnSync("clang", [
      "--target=x86_64-unknown-none-elf", "-std=c11", "-ffreestanding",
      "-Werror", "-fsyntax-only", out
    ], { encoding: "utf8" });
    if (clang.error && (clang.error as NodeJS.ErrnoException).code === "ENOENT") return;
    assert.equal(clang.status, 0, clang.stderr);
    const harness = out + ".harness.c";
    const executable = out + ".harness";
    fs.writeFileSync(harness, generated + [
      "",
      "uint64_t __bake_c_bigint(double value) { return (uint64_t)value; }",
      "int main(void) {",
      "  croissant_init_globals();",
      "  croissant_native_kernel_ts__CpuState cpu = croissant_native_kernel_ts__initial(0);",
      "  return croissant_native_kernel_ts__step(cpu, 6) == UINT64_C(0x100f) ? 0 : 1;",
      "}"
    ].join("\n"));
    const compiled = spawnSync("clang", ["-std=c11", "-O1", harness, "-o", executable], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    const executed = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(executed.status, 0, executed.stderr);
    fs.mkdirSync(path.join(process.cwd(), "build"), { recursive: true });
    fs.copyFileSync(out, path.join(process.cwd(), "build/fixture.c"));
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("rejects JavaScript runtime arrays without emitting partial C", () => {
  const { root, manifestPath, out } = project({
    "unsafe.ts": "export function bad(): number { const items: number[] = [1, 2]; return items[0]!; }"
  });
  try {
    assert.throws(() => compile({ manifestPath, outputPath: out }), /CR106|CR211|CR205/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("rejects non-Bake manifests before reading code", () => {
  const { root, manifestPath, out } = project({ "input.ts": fixture });
  try {
    fs.writeFileSync(manifestPath, JSON.stringify({
      target: { backend: "wasm", freestanding: false }, sourceFiles: ["input.ts"]
    }));
    assert.throws(() => compile({ manifestPath, outputPath: out }), /CR001/);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("native buffer aliases retain identity even for equal-length allocations", () => {
  const source = [
    "interface __bake_c_Buffer { readonly byteLength: number; }",
    "interface __bake_c_View { readonly buffer: __bake_c_Buffer; }",
    "declare function __bake_c_new_buffer(size: number): __bake_c_Buffer;",
    "declare function __bake_c_new_view(buffer: __bake_c_Buffer): __bake_c_View;",
    "declare function __bake_c_view_set_u32(view: __bake_c_View, at: number, value: number, littleEndian: boolean): void;",
    "declare function __bake_c_view_get_u32(view: __bake_c_View, at: number, littleEndian: boolean): number;",
    "export function exercise(): number {",
    "  const a = __bake_c_new_buffer(8);",
    "  const b = __bake_c_new_buffer(8);",
    "  const av = __bake_c_new_view(a);",
    "  const alias = __bake_c_new_view(a);",
    "  const bv = __bake_c_new_view(b);",
    "  __bake_c_view_set_u32(av, 0, 17, true);",
    "  __bake_c_view_set_u32(bv, 0, 29, true);",
    "  return __bake_c_view_get_u32(alias, 0, true) * 100 + __bake_c_view_get_u32(bv, 0, true);",
    "}"
  ].join("\n");
  const { root, manifestPath, out } = project({ "buffer.ts": source });
  try {
    compile({ manifestPath, outputPath: out });
    const generated = fs.readFileSync(out, "utf8");
    assert.match(generated, /struct __bake_c_Buffer \{\s*uint64_t handle;\s*double byteLength;/);
    const harness = out + ".harness.c", executable = out + ".harness";
    fs.writeFileSync(harness, generated + [
      "",
      "static uint32_t slots[2]; static uint64_t next;",
      "__bake_c_Buffer __bake_c_new_buffer(double size) { return (__bake_c_Buffer){ .handle = ++next, .byteLength = size }; }",
      "__bake_c_View __bake_c_new_view(__bake_c_Buffer buffer) { return (__bake_c_View){ .buffer = buffer }; }",
      "void __bake_c_view_set_u32(__bake_c_View view, double at, double value, bool le) { slots[view.buffer.handle - 1] = (uint32_t)value; }",
      "double __bake_c_view_get_u32(__bake_c_View view, double at, bool le) { return slots[view.buffer.handle - 1]; }",
      "int main(void) { return croissant_buffer_ts__exercise() == 1729 ? 0 : 1; }"
    ].join("\n"));
    const built = spawnSync("clang", ["-std=c11", "-Werror", harness, "-o", executable], { encoding: "utf8" });
    if ((built.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    assert.equal(built.status, 0, built.stderr);
    const ran = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("unsigned right shift uses JavaScript ToUint32 semantics", () => {
  const { root, manifestPath, out } = project({
    "shift.ts": "export function shift(value: number, count: number): number { return value >>> count; }"
  });
  try {
    compile({ manifestPath, outputPath: out });
    const output = fs.readFileSync(out, "utf8");
    assert.match(output, /return croissant_js_ushr\(value, count\);/);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
