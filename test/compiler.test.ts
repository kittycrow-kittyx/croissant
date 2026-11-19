import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("transpiles typed Bake subset to freestanding C", () => {
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
    assert.match(generated, /croissant_native_kernel_ts__step/);
    assert.match(generated, /__bake_c_bigint\(index\)/);
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
    assert.match(generated, /__bake_c_new_view\(a\)/);
    assert.match(generated, /__bake_c_new_view\(b\)/);
    assert.match(generated, /__bake_c_view_get_u32\(alias,/);
    assert.match(generated, /__bake_c_view_get_u32\(bv,/);
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

test("mixed signed and unsigned 32-bit arguments preserve their numeric value", () => {
  const source = [
    "export type I32 = number;",
    "export type U32 = number;",
    "export type I64 = bigint;",
    "declare function __bake_c_bigint(value: number): bigint;",
    "export function word(value: I32 | U32): I64 { return __bake_c_bigint(value); }",
    "export function relative(pc: bigint, offset: I32): I64 { return pc + word(offset); }",
    "export function unsignedWord(value: U32): I64 { return word(value); }"
  ].join("\n");
  const { root, manifestPath, out } = project({ "signed.ts": source });
  try {
    compile({ manifestPath, outputPath: out });
    const generated = fs.readFileSync(out, "utf8");
    assert.match(generated, /int64_t croissant_signed_ts__word\(int64_t value\)/);
    assert.match(generated, /croissant_signed_ts__relative/);
    assert.match(generated, /croissant_signed_ts__unsignedWord/);
    assert.match(generated, /__bake_c_bigint\(value\)/);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("numeric bitwise compound assignments lower through integer coercion", () => {
  const { root, manifestPath, out } = project({
    "bits.ts": [
      "export type U32 = number;",
      "export function bits(flag: number): U32 { let value: U32 = 0; value |= flag; value &= 7; value ^= 2; value <<= 1; value >>= 1; value >>>= 0; return value; }",
      "export function plain(flag: number): number { let value: number = 1; value |= flag; return value; }"
    ].join("\n")
  });
  try {
    compile({ manifestPath, outputPath: out });
    const output = fs.readFileSync(out, "utf8");
    assert.match(output, /value = croissant_js_or\(value, flag\)/);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
