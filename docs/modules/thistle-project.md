# Thistle integration project

Run `node dist/src/thistle-project.js /path/to/thistle`. The script checks the eight native entry files and writes tsconfig.croissant.json in the specified source checkout. It does not change kernel source files. The generated config selects native modules and enables strict TypeScript checking for the Bake lowering stage.
