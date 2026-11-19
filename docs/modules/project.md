# Modular C project

`emitProject(input: ProjectInputs)` writes a staged project containing translation units, per-module headers, shared ABI declarations and CMake configuration. `ProjectInputs` contains the target directory, context, emitter, source files, types and registered declarations. `ProjectResult` reports the published directory and relative output paths. Destinations must not overwrite the Bake input tree.
