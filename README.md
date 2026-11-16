# Croissant

**CROISSANT**: Croissant Recursively Optimises Intermediate Sources, Synthesising Architecture-Neutral Translations.

A TypeScript compiler backend that converts `Bake --target=clang` output into **freestanding C**. Its source is canonical Thistle, not a maintained C kernel fork. Croissant and its CLI are written entirely in TypeScript.

## Build

```sh
npm install
npm run check
npm test
```

The compiler consumes `bake-manifest.json`, resolves source modules and emits one C translation unit. Unsupported constructs cause a source-located `CRxxx` error; no partial C file is published.

```sh
node dist/src/cli.js --manifest /path/to/bake-clang/bake-manifest.json --out build/thistle.c
```

## Canonical Thistle pipeline

With sibling checkouts named `croissant/`, `bake/` and `thistle/`, and Node, Bun and Clang installed:

```sh
npm install --prefix croissant
npm install --prefix bake
npm run build --prefix croissant
node croissant/dist/src/thistle-project.js thistle
(cd bake && bun src/cli.ts --project ../thistle/tsconfig.croissant.json --out-dir build/croissant-bake --target=clang)
node croissant/dist/src/cli.js --manifest thistle/build/croissant-bake/bake-manifest.json --out croissant/build/thistle.c
clang --target=x86_64-unknown-none-elf -std=c11 -O1 -ffreestanding -fno-builtin -fno-stack-protector -Werror -c croissant/build/thistle.c -o croissant/build/thistle-x86_64.o
clang --target=aarch64-none-elf -std=c11 -O1 -ffreestanding -fno-builtin -fno-stack-protector -Werror -c croissant/build/thistle.c -o croissant/build/thistle-aarch64.o
```

GitHub Actions runs this integration against Thistle's full native source and verifies both relocatable ELF objects. The pipeline leaves Bake's default WASM/Baguette lowering unchanged.

## Boundary

The C output is a **compile-time milestone**, not Rei yet. Native objects still contain unresolved `__bake_c_*` platform calls and Croissant's numeric conversion intrinsics. They cannot be linked or booted until these have freestanding implementations, a hardware abstraction layer, a linker script and an architecture-specific boot entry point. Generating valid C does not establish semantic equivalence for every arithmetic edge case, memory operation or concurrency path. Those are separate tests required before running the kernel on hardware.
