# Compiler entry point

| Export | Contract |
| --- | --- |
| `CompileRequest` | Bake manifest path and exactly one output file or directory |
| `CompileResult` | Output path, counts of source files, functions, globals and interfaces, optional generated file list |
| `compile` | Validate the clang manifest, check TypeScript, register declarations and publish generated C |
| `CompilerError` | Source-located compiler diagnostic |

Invalid manifests and unsupported native operations throw before publication. 
