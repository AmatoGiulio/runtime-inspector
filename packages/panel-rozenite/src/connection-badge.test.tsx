import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PanelState } from "@runtime-inspector/panel-core";
import { ConnectionBadge } from "./connection-badge";

describe("connection badge", () => {
  it("counts only stale schemas, not retained false entries", () => {
    const state = {
      status: "connected",
      staleSchemaIds: { active: false },
    } as unknown as PanelState;
    expect(renderToStaticMarkup(<ConnectionBadge state={state} />)).toContain(
      ">connected<",
    );
    expect(
      renderToStaticMarkup(
        <ConnectionBadge
          state={{ ...state, staleSchemaIds: { active: false, stale: true } }}
        />,
      ),
    ).toContain(">1 stale<");
  });
});
