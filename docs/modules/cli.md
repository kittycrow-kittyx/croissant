# Command line

Run `node dist/src/cli.js --manifest /path/to/bake-manifest.json --out-dir build/rei` after building the compiler. Use --out for single-file C output or --out-dir for a modular project, not both. Invalid arguments exit 2; compilation errors exit 1. Success prints the output path and declaration counts.
