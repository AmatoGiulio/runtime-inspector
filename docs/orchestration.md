# Orchestration model

This project is developed with a multi-agent workflow. This document defines the roles, the loop every change goes through, and the conventions that make the history readable. It exists so any future session — human or agent — can pick up the same working style without re-deriving it.

## Roles

**Orchestrator (the brain — most capable model available, e.g. Fable).**
Does not write feature code. Responsibilities:

- Understands the goal, reads the docs and the code, makes every design decision.
- Writes the specs handed to dev agents: precise, bounded, with explicit "do NOT" clauses and a verification section.
- Writes design documents itself: RFCs, normative docs, architecture notes, this file. Writing contracts is thinking, and thinking is the orchestrator's job.
- Reviews every dev diff against the spec before it is committed. Small surgical touch-ups (removing a stray comment, one-line hotfixes under time pressure) are allowed; anything larger goes back to a dev.
- Leads debugging: forms hypotheses, gathers evidence with targeted commands, decides the fix, then either applies it (if tiny) or specs it out.
- Owns the commit: stages, writes the message, commits. Dev agents never commit.

**Dev agents (Sonnet or Opus).**
Execute one spec each, exactly. Expectations:

- No invention, no scope creep, no "while I was here" changes.
- If the spec is impossible or ambiguous: STOP and report, do not improvise. Judgment calls that were genuinely necessary must be flagged explicitly in the final report as deviations, with rationale.
- Run the verification commands from the spec before reporting.
- Report: files changed, test counts, outcomes, deviations.
- When two devs run in parallel, their specs must touch disjoint packages; each spec names the packages the other is working in as off-limits.

**Worker agents (Haiku).**
Mechanical execution only: run exactly the listed commands (build, test, typecheck, counts), report raw results verbatim, never modify files. Used as the independent verification step after every dev task — independent meaning: not the agent that wrote the code.

## The loop

Every unit of work follows the same cycle:

1. **Decide** (orchestrator): design the change; for protocol changes, write an RFC in `rfcs/` first.
2. **Spec** (orchestrator → dev): a self-contained prompt with repo context, exact file paths, behavioral requirements, test plan, verification commands, and prohibitions.
3. **Execute** (dev): implement, verify, report. No commits.
4. **Review** (orchestrator): read the diff at the critical points; check deviations against the spec; reject or touch up.
5. **Verify** (worker): `pnpm -r build && pnpm -r test && pnpm -r typecheck` run fresh, results verbatim.
6. **Commit** (orchestrator): style below.
7. **Validate on hardware** (user): anything touching the device loop gets a manual checklist on a real device before it counts as done. Tests prove logic; the panel moving a card on a phone proves the product.

## Commit conventions

- Short imperative subject, 3-6 words, no scopes/prefixes (matches existing history: "Add MCP agent client", "Harden broker handshake").
- No Co-Authored-By lines. Ever.
- One logical change per commit; parallel dev tasks land as separate commits even when verified together.
- RFC and implementation are separate commits ("Add protocol 0.3 RFC" → "Ship protocol 0.3 semantic messages").

## Standing decisions (do not relitigate without new evidence)

- Protocol: reject-don't-clamp; taxonomy State/Command/Lifecycle; version check at handshake only; tolerant readers. See docs/protocol-stability.md.
- Deferred by decision, with written rationale: `control.path`, capability negotiation, request/response RPC (RFC 0001), react-native-web discovery.
- `runtime-react-native` ships CJS (guarded requires of optional peers break in ESM dists — bug class seen twice).
- Reanimated/React must be singletons in the monorepo example (metro.config.js).
- Feature freezes are respected: consolidation phases add no features.

## Lessons already paid for

- Silent fallbacks hide real failures for days; every fallback path must warn in dev. The discovery cascade and `makeMutable` fallback both bit us before they warned.
- The emulator can mask device-only failure paths (loopback fallback masked broken scriptURL discovery). Physical-device validation is part of the definition of done.
- Docs drift is poison for agent-driven repos: features shipped but marked "planned" send future agents in circles. Doc updates belong in the same change set as the code.
