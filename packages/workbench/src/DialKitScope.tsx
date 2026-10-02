import type { ReactNode } from "react";
import type { InspectorPanelTheme } from "@runtime-inspector/panel-dialkit";

/** Single switch for the DialKit theme used by every shared control row in the Workbench. */
export const DIALKIT_THEME: InspectorPanelTheme = "dark";

/**
 * The minimum DialKit markup that `InspectorControlRow` needs around it: the
 * `dialkit-root` element carries the `--dial-*` tokens and the theme, and the
 * inline `dialkit-panel` / `dialkit-panel-wrapper` give rows their layout. This
 * mirrors `InspectorPanel` in `panel-dialkit` without its root folder chrome.
 */
export function DialKitScope({
  theme = DIALKIT_THEME,
  children
}: {
  theme?: InspectorPanelTheme;
  children: ReactNode;
}) {
  return (
    <div
      className="dialkit-root ri-panel ri-workbench-dialkit"
      data-mode="inline"
      data-theme={theme}
    >
      <div className="dialkit-panel" data-mode="inline">
        <div className="dialkit-panel-wrapper">
          <div className="ri-workbench-dialkit-rows">{children}</div>
        </div>
      </div>
    </div>
  );
}
