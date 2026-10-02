import type { ReactNode } from "react";

/**
 * The minimum DialKit markup that `InspectorControlRow` needs around it: the
 * `dialkit-root` element carries the `--dial-*` tokens and the theme, and the
 * inline `dialkit-panel` / `dialkit-panel-wrapper` give rows their layout. This
 * mirrors `InspectorPanel` in `panel-dialkit` without its root folder chrome.
 */
export function DialKitScope({
  theme,
  children
}: {
  /** The Workbench's resolved theme; DialKit's own `system` mode is never used here. */
  theme: "light" | "dark";
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
