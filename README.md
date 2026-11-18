# Croissant

**CROISSANT**: Croissant Recursively Optimises Intermediate Sources,
Synthesising Architecture-Neutral Translations.

Croissant compiles freestanding TypeScript emitted by Bake's `clang` target
into C. It consumes `bake-manifest.json` and resolves symbols across modules.

## Build and test

```sh
npm install
npm run build
npm run check
npm test
```

## Compile

Prepare a TypeScript project with Bake's `--target=clang` option, then pass
its emitted manifest to Croissant:

```sh
node dist/src/cli.js --manifest /path/to/bake-output/bake-manifest.json \
  --out-dir build/native
cmake -S build/native -B build/native-objects
cmake --build build/native-objects --parallel 2
```

The output includes one C source and header per input module, shared type,
intrinsic and global headers, a CMake project and `croissant.manifest.json`.
`--out FILE` selects the legacy single-file emitter instead of `--out-dir`.

The input manifest must declare the `clang` backend and freestanding output.
The compiler accepts native intrinsic ABI 1. Unsupported operations produce
source-located `CRxxx` diagnostics. Directory output is staged before
publication.

The generated C declares external `__bake_c_*` and numeric intrinsics. The
consumer supplies these implementations before linking the generated objects.

## Native representation

Generated `__bake_c_Buffer` records contain a 64-bit opaque allocation
handle and `byteLength`. Views share the handle rather than copying the
backing storage. The platform resolves handles and validates bounds.
Separate allocations require distinct identities, even when their
lengths match.

Unsigned right shifts use the numeric intrinsic to preserve
JavaScript's unsigned coercion semantics, including negative
`Math.imul` results.

Generated objects and platform implementations must use compatible
buffer layouts.

## Integration fixture

`src/thistle-project.ts` prepares a Thistle native-source project for the
compiler's integration checks. This helper is not required to compile other
projects. CI compiles generated translation units for x86-64 and AArch64 and
runs a linked native fixture.

## Documentation

[Module reference](docs/index.md)

`npm run guards` runs the mandatory strict source, test and documentation checks independently of compilation.

## Licence

[MIT](LICENSE).
