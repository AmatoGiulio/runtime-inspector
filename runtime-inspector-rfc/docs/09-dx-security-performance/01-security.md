# Security

Runtime Inspector is a development tool. It must be disabled in production by default.

## Risks

- exposing internal app state
- allowing remote patching
- leaking local network data
- connecting to untrusted clients

## Rules

- enabled only in development by default
- explicit opt-in for production-like environments
- local network warning
- optional pairing code
- client allowlist
- schema-level permissions in future

## MVP security

For MVP:

- `__DEV__` guard
- random session token printed in terminal
- panel must provide token during handshake
- no cloud transport
