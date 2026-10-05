/**
 * Hand-off between the start helpers (`__riAnimationDelay` / `__riAnimationStart`)
 * and `__riObserveAnimation`: the delay applied for a call site, in milliseconds,
 * recorded just before the observer runs for the same assignment (RFC 0005 §3c).
 * Deliberately has no imports so both modules can depend on it.
 */
const appliedStartDelays = new Map<string, number>();

export function recordAppliedStartDelay(callsiteId: string, ms: number): void {
  appliedStartDelays.set(callsiteId, ms);
}

/** Returns and deletes the recorded delay; `undefined` when no start helper ran. */
export function consumeAppliedStartDelay(callsiteId: string): number | undefined {
  const ms = appliedStartDelays.get(callsiteId);
  appliedStartDelays.delete(callsiteId);
  return ms;
}

/** Drops every recorded delay whose call site matches `predicate`. */
export function dropAppliedStartDelays(predicate: (callsiteId: string) => boolean): void {
  for (const callsiteId of [...appliedStartDelays.keys()]) {
    if (predicate(callsiteId)) appliedStartDelays.delete(callsiteId);
  }
}

/** Test-only: clears module-level state between test runs. */
export function __resetAnimationStartStateForTests(): void {
  appliedStartDelays.clear();
}
