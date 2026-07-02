# Protocol conformance fixtures

These JSON files are the language-independent conformance contract for the Runtime Inspector Protocol. Any implementation — TypeScript, Rust, Go, Swift, Kotlin, anything — must satisfy:

- every file in `valid/` parses as a well-formed protocol message;
- every full-message file in `invalid/` is rejected by the message parser;
- `invalid/` files named `*-value-*` (value-level cases) are well-formed messages whose `value` must be rejected by control-value validation against the control declared in the corresponding test (see `src/conformance.test.ts` for the reference wiring).

The TypeScript suite (`src/conformance.test.ts`) discovers fixtures with a directory scan, so adding a file here automatically extends the suite. New protocol messages MUST land together with their fixtures — see [docs/protocol-stability.md](../../../docs/protocol-stability.md).
