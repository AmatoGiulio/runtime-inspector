# RFC 001: Protocol-first Architecture

## Status

Draft

## Summary

The central artifact is not the panel and not the React Native SDK. The central artifact is the Runtime Inspector Protocol.

## Motivation

If the protocol is stable and declarative, multiple clients and runtimes can exist without rewriting the system.

## Decision

All runtime-client communication must go through explicit protocol messages.

The React Native SDK and Web Panel are reference implementations, not the protocol itself.

## Consequences

- More upfront design
- Better long-term extensibility
- Easier future support for desktop, VS Code, DevTools and other runtimes
