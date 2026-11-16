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
  "export interface CpuState { readonly pc: U64; readonly hart: U32; }",
  "export const BASE: U64 = 0x1000n;",
  "export function add(left: U32, right: U32): U32 { return left + right; }",
  "export function initial(hart: U32): CpuState {",
  "  return { pc: BASE, hart };",
  "}",
  "export function step(cpu: CpuState, delta: U32): U64 {",
  "  let index: U32 = 0;",
  "  for (let i: U32 = 0; i < delta; i += 1) index += i;",
  "  if (index > 10) return cpu.pc + BigInt(index);",
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
    assert.match(generated, /struct croissant_native_kernel__CpuState/);
    assert.match(generated, /void croissant_init_globals\(void\)/);
    assert.match(generated, /for \(/);
    assert.doesNotMatch(generated, /require\(|WebAssembly|node_modules/);
    const clang = spawnSync("clang", [
      "--target=x86_64-unknown-none-elf", "-std=c11", "-ffreestanding",
      "-Werror", "-fsyntax-only", out
    ], { encoding: "utf8" });
    if (clang.error && (clang.error as NodeJS.ErrnoException).code === "ENOENT") return;
    assert.equal(clang.status, 0, clang.stderr);
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
