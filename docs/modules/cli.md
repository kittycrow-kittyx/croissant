# Command line

Run `node dist/src/cli.js --manifest /path/to/bake-manifest.json --out-dir build/rei` after building the compiler. Use --out for single-file C output or --out-dir for a modular project, not both. 

| Exit status | Meaning |
| --- | --- |
| 2 | Invalid arguments |
| 1 | Compilation failure |
 Success prints the output path and declaration counts.
