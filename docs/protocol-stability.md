# Protocol stability policy

This document defines what counts as a breaking change to the Runtime Inspector Protocol and what every implementation may rely on. It exists to end compatibility debates before they start: if a question about change safety comes up, the answer should be derivable from this page. Normative language (MUST/SHOULD) follows RFC 2119 conventions.

The protocol version lives in `packages/protocol` (`RIP_VERSION`) and is exchanged once, at handshake. The broker rejects mismatched versions with `VERSION_MISMATCH` and closes the connection. Version checks never happen per-message.

## Non-breaking (additive) changes

These do NOT require a version bump:

- Adding a new message type. Parsers MUST ignore message types they do not recognize.
- Adding an optional field to an existing message. Parsers MUST ignore fields they do not recognize.
- Adding a new control kind. Panels that do not recognize a kind MUST skip rendering it (and MUST NOT fail the whole schema).
- Adding a new error code. Clients MUST treat unrecognized error codes as generic errors.
- Adding entries to non-normative metadata (e.g. presentation hints).
- Relaxing a validation rule (accepting values that were previously rejected).

## Breaking changes

These REQUIRE a version bump and an RFC in `rfcs/`:

- Changing the semantics of an existing message (what receivers are expected to do with it).
- Removing or renaming a message type, a field, or a control kind.
- Making an optional field required, or changing a field's type.
- Tightening a validation rule (rejecting values that were previously accepted) — the slider min/max enforcement shipped inside the 0.3 bump for this reason.
- Changing broker routing/caching rules for an existing message in a way clients can observe.

## Rules every implementation MUST follow

1. **Tolerant reader.** Ignore unknown message types and unknown fields. Never fail parsing because of extra data.
2. **No round-trip preservation guarantee.** A sender MUST NOT rely on receivers or the broker preserving fields they do not understand. If a field matters, the consumer must be known to support it.
3. **Reject, don't clamp.** Invalid values (wrong shape, out of declared range) are rejected with a reason, never silently coerced. A client must always be able to assume that a value it sent was either applied exactly or rejected explicitly — silent modification makes machine-driven tuning impossible.
4. **Commands are not state.** Command messages (`control.trigger`) are never cached, persisted, or replayed. State messages are idempotent and last-write-wins. See the taxonomy in [protocol.md](protocol.md).
5. **Version at handshake only.** After a successful handshake, both sides assume the negotiated version for the lifetime of the connection.
6. **Conformance fixtures are the contract.** Every implementation, in any language, MUST pass the fixture suite in `packages/protocol/fixtures/` (see its README). A change that alters fixture outcomes is at minimum a rule change and MUST be evaluated against the two lists above.

## Process

Any protocol change starts as an RFC in `rfcs/` (motivation, message definitions, taxonomy family, broker rules, compatibility impact, test plan) before implementation. Additive changes still add fixtures; breaking changes bump `RIP_VERSION`, migrate every client in this repo in the same change set, and update the fixture suite.

## Future extensions (recorded, not designed)

- Hierarchical control addressing (`control.path`) may be introduced if real-world schemas require it. It would ship as an optional additive field; its semantics (dot notation, array path, or other) will be chosen against concrete cases, not speculatively. Until then, control ids MUST be unique per schema.
- Capability negotiation (`panel.capabilities` / `runtime.info`) is deferred until a second heterogeneous client exists. See RFC 0001's deferred section for rationale.
