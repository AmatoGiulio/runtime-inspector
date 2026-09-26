import type { PanelState } from "@runtime-inspector/panel-core";
export function ConnectionBadge({ state }: { state: PanelState }) {
  const staleCount = Object.values(state.staleSchemaIds).filter(Boolean).length;
  const label = staleCount > 0 ? `${staleCount} stale` : state.status;
  return (
    <span
      className={`ri-status ri-status-${staleCount ? "stale" : state.status}`}
    >
      {label}
    </span>
  );
}
