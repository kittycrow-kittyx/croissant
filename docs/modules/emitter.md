# C emitter

`Emitter` accepts a Context. The expression, statement, functionSignature and function methods emit C text from the corresponding TypeScript nodes. Native numeric intrinsics preserve JavaScript coercion for bitwise operations. The emitter serialises objects as typed record initialisers and resolves default arguments against the source declaration. Unsupported syntax raises a source-located diagnostic; no files are written by this module.
