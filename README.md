# Croissant

**CROISSANT**: Croissant Recursively Optimises Intermediate Sources, Synthesising Architecture-Neutral Translations.

Croissant compiles `Bake --target=clang` TypeScript into **freestanding C**. It is implemented in TypeScript and preserves Thistle as the canonical source of kernel behaviour.

## Build and test

```sh
npm install
npm run check
npm test
```

Croissant consumes `bake-manifest.json`, resolves cross-module symbols and generates a **modular C project**. One TypeScript implementation module produces one `.c` file and one `.h` header, with separate shared type, intrinsic, global and aggregator headers. A CMake project and provenance manifest are also generated.

```sh
node dist/src/cli.js --manifest /path/to/bake-clang/bake-manifest.json --out-dir build/rei
cmake -S build/rei -B build/rei-objects
cmake --build build/rei-objects -j
```

Output structure:

```text
build/rei/
├── include/croissant/
│   ├── types.h
│   ├── intrinsics.h
│   ├── globals.h
│   ├── all.h
│   ├── core/*.h
│   ├── native/*.h
│   └── vm/*.h
├── src/
│   ├── globals.c
│   ├── core/*.c
│   ├── native/*.c
│   └── vm/*.c
├── CMakeLists.txt
└── croissant.manifest.json
```

Every generated C source is independently compiled and can be rebuilt without regenerating unrelated source files. Missing or unsupported operations cause a source-located `CRxxx` error before the source tree is published. Output publication uses a staging directory, and a failed compilation preserves previously published output.

The legacy `--out build/rei.c` mode still emits a monolithic C file for compatibility. **New builds should use `--out-dir`.**

## Canonical Thistle pipeline

With sibling checkouts named `thistle/`, `bake/` and `croissant/`:

```sh
npm install --prefix croissant
npm install --prefix bake
npm run build --prefix croissant
node croissant/dist/src/thistle-project.js thistle
(cd bake && bun src/cli.ts --project ../thistle/tsconfig.croissant.json --out-dir build/croissant-bake --target=clang --engine=host)
node croissant/dist/src/cli.js --manifest thistle/build/croissant-bake/bake-manifest.json --out-dir croissant/build/rei
cmake -S croissant/build/rei -B croissant/build/rei-objects
cmake --build croissant/build/rei-objects -j
```

GitHub Actions also builds every C translation unit individually for **x86-64 and AArch64** using freestanding Clang, and runs a linked native multi-module smoke test. Bake's default WASM/Baguette lowering remains unchanged.

## Relationship to Rei

Like Teto, Rei should own its build orchestration and target integration, not a maintained fork of the Thistle kernel. Rei can pin a Thistle revision, invoke Bake and Croissant, then combine these generated modules with its native platform implementations, architecture boot code and linker scripts.

Croissant's generated native objects currently retain unresolved `__bake_c_*` and numeric intrinsics. A successful compilation is **not** a linked, bootable Rei kernel or proof of complete semantic equivalence. Those require native implementations and further runtime validation.

### Native allocation identity

Generated `__bake_c_Buffer` records carry a 64-bit opaque `handle` and
`byteLength`, matching the allocation-identity model in Crust. Views copy
the handle, not the backing storage. The platform resolves the handle and
validates bounds; equal-length allocations must remain distinct. Rebuild
all generated objects and their platform implementations together after
this layout change. The Bake source-intrinsic contract is unchanged.

Unsigned right shifts use the native JavaScript numeric intrinsic rather than
an unchecked conversion from a negative floating-point value to uint32_t.
This preserves the signed Math.imul result before the source's >>> 0 coercion.
