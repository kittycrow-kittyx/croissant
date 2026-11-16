# Croissant

**CROISSANT**: Croissant Recursively Optimises Intermediate Sources, Synthesising Architecture-Neutral Translations.

Ahead-of-time compiler backend for `Bake --target=clang` output. Croissant generates **freestanding C** from the single canonical Thistle TypeScript kernel. C is compiled for bare-metal targets such as AArch64 or x86-64 by Clang; there is no JavaScript, WASM, Bun, Node, or Linux runtime on the target computer.

Source input: Bake-lowered TypeScript plus `bake-manifest.json`. Unsupported semantics are compilation **errors**, not silent stubs or dynamic fallbacks. The native platform implementation and boot code are independent from Croissant's frontend and must not duplicate Thistle's kernel logic.

This repository contains the compiler implementation and compile-time regression tests. It does not contain a second implementation of Thistle.
