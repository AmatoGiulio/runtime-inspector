// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PanelSession, PanelState } from "@runtime-inspector/panel-core";
import type { PanelSchema } from "@runtime-inspector/protocol";
import { ConnectionBadge, InspectorPanel } from "./index";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const anchor = {
  file: "src/Card.tsx",
  line: 4,
  column: 2,
  enclosure: ["Card"],
  name: "blur",
  init: "18",
};

const schema: PanelSchema = {
  id: "card",
  title: "Card",
  groups: [
    {
      id: "look",
      label: "Look",
      controls: [
        { id: "blur", kind: "slider", label: "Blur", defaultValue: 18, min: 0, max: 40, source: anchor },
        { id: "radius", kind: "slider", label: "Radius", defaultValue: 8, min: 0, max: 32 },
        { id: "replay", kind: "trigger", label: "Replay" },
      ],
    },
  ],
};

function makeSession(): PanelSession {
  return {
    getState: vi.fn(),
    subscribe: vi.fn(),
    connect: vi.fn(),
    dispose: vi.fn(),
    setValue: vi.fn(),
    commitValue: vi.fn(),
    fireTrigger: vi.fn(),
    saveCompareSlot: vi.fn(),
    applyCompareSlot: vi.fn(),
    exportTypeScript: vi.fn(() => "export const card = {};"),
    applySource: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    clearRecording: vi.fn(),
  };
}

function makeState(overrides: Partial<PanelState> = {}): PanelState {
  return {
    status: "connected",
    schemas: [schema],
    staleSchemaIds: {},
    values: { card: { blur: 20 } },
    traceSchemas: {},
    compareSlots: {},
    ...overrides,
  };
}

describe("InspectorPanel", () => {
  it("offers write-back only for anchored controls when a workspace is reachable", () => {
    const session = makeSession();
    const view = render(<InspectorPanel session={session} state={makeState()} canApplySource />);

    fireEvent.click(screen.getByRole("button", { name: "Apply Blur to code" }));
    expect(session.applySource).toHaveBeenCalledExactlyOnceWith("card", ["blur"]);
    expect(screen.queryByRole("button", { name: "Apply Radius to code" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Apply all Card values to code" }));
    expect(session.applySource).toHaveBeenLastCalledWith("card");

    view.rerender(<InspectorPanel session={session} state={makeState()} />);
    expect(screen.queryByRole("button", { name: /to code/ })).toBeNull();
  });

  it("routes A/B snapshots through the session and blocks apply while stale", () => {
    const session = makeSession();
    const view = render(
      <InspectorPanel session={session} state={makeState({ compareSlots: { card: { A: { blur: 4 } } } })} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    fireEvent.click(screen.getByRole("button", { name: "Save snapshot B" }));
    expect(session.saveCompareSlot).toHaveBeenCalledWith("B", "card");
    fireEvent.click(screen.getByRole("button", { name: "Apply snapshot A" }));
    expect(session.applyCompareSlot).toHaveBeenCalledWith("A", "card");
    expect(screen.getByRole("button", { name: "Apply snapshot B" })).toHaveProperty("disabled", true);

    view.rerender(
      <InspectorPanel
        session={session}
        state={makeState({ compareSlots: { card: { A: { blur: 4 } } }, staleSchemaIds: { card: true } })}
      />
    );
    expect(screen.getByRole("button", { name: "Apply snapshot A" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.getByText(/frozen until it publishes again/)).toBeTruthy();
  });

  it("uses session values and fires triggers as commands", () => {
    const session = makeSession();
    render(<InspectorPanel session={session} state={makeState()} />);
    expect(screen.getByRole("slider", { name: /blur/i }).getAttribute("aria-valuenow")).toBe("20");
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(session.fireTrigger).toHaveBeenCalledExactlyOnceWith("card", "replay");
  });

  it("shows the export and apply results", () => {
    const session = makeSession();
    render(
      <InspectorPanel
        session={session}
        state={makeState({
          lastApplyResult: {
            schemaId: "card",
            at: "12:00:00",
            results: [{ controlId: "blur", ok: true, written: "20", previous: "18" }],
          },
        })}
      />
    );
    expect(screen.getByRole("status").textContent).toBe("blur → 20 written");
    fireEvent.click(screen.getByRole("button", { name: "Show code" }));
    expect(screen.getByText("export const card = {};")).toBeTruthy();
  });

  it("explains how to publish when no schema exists yet", () => {
    render(<InspectorPanel session={makeSession()} state={makeState({ schemas: [], values: {} })} />);
    expect(screen.getByText("Waiting for the app")).toBeTruthy();
  });
});

describe("ConnectionBadge", () => {
  it("counts only stale schemas, not retained false entries", () => {
    const state = makeState({ staleSchemaIds: { active: false } });
    expect(renderToStaticMarkup(<ConnectionBadge state={state} />)).toContain("connected</span>");
    expect(
      renderToStaticMarkup(
        <ConnectionBadge state={{ ...state, staleSchemaIds: { active: false, stale: true } }} />
      )
    ).toContain("1 stale</span>");
  });
});