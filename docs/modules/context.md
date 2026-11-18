# C type context

| Export | Responsibility |
| --- | --- |
| `CompilerError` | Source-located CR diagnostic with code, file and line |
| `cIdentifier` | Escape C keywords when naming symbols |
| `Context` | Register symbols, resolve aliases, generate module names and translate scalar, literal, union and interface types |

Mixed signed and unsigned 32-bit values use a signed 64-bit representation. Unsupported types raise a compiler error rather than introducing dynamic values.
