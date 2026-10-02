/** localStorage key for the user-chosen timeline height in px. Absent means the CSS default. */
export const TIMELINE_HEIGHT_STORAGE_KEY = "runtime-inspector.workbench.timeline-height";

const TOPBAR_HEIGHT_PX = 44;
const MIN_TIMELINE_HEIGHT_PX = 200;
const MIN_STAGE_HEIGHT_PX = 260;

/**
 * Bounds a timeline height to [200, viewportHeight - topbar - 260] so the stage always keeps room
 * for the device. The lower bound wins on tiny viewports. Returns an integer; a non-finite input
 * gets the lower bound.
 */
export function clampTimelineHeight(px: number, viewportHeight: number): number {
  const max = Math.max(
    MIN_TIMELINE_HEIGHT_PX,
    viewportHeight - TOPBAR_HEIGHT_PX - MIN_STAGE_HEIGHT_PX
  );
  if (!Number.isFinite(px)) return MIN_TIMELINE_HEIGHT_PX;
  return Math.round(Math.min(max, Math.max(MIN_TIMELINE_HEIGHT_PX, px)));
}
