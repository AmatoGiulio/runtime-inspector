// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InspectorControlRow, type InspectorControlProps } from "./index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const slider = {
  id: "speed",
  label: "Speed",
  kind: "slider" as const,
  min: 0,
  max: 10,
  step: 0.1,
  defaultValue: 1,
};
function props(
  control: InspectorControlProps["control"] = slider,
): InspectorControlProps {
  return {
    session: { setValue: vi.fn(), commitValue: vi.fn(), fireTrigger: vi.fn() },
    schemaId: "first",
    control,
    value: undefined,
    disabled: false,
  };
}
describe("controlled DialKit renderer", () => {
  it("sends the keyboard slider patch before one commit and uses externally supplied values", () => {
    const p = props();
    const view = render(<InspectorControlRow {...p} />);
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(p.session.setValue).toHaveBeenCalledWith("first", "speed", 1.1);
    expect(p.session.commitValue).not.toHaveBeenCalled();
    fireEvent.keyUp(screen.getByRole("slider"), { key: "ArrowRight" });
    fireEvent.blur(screen.getByRole("slider"));
    expect(p.session.commitValue).toHaveBeenCalledExactlyOnceWith(
      "first",
      "speed",
    );
    view.rerender(<InspectorControlRow {...p} value={4} />);
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("4");
  });
  it("isolates identical control ids in different schemas, clearing unfinished editor state", () => {
    const p = props();
    const view = render(<InspectorControlRow {...p} />);
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    view.rerender(<InspectorControlRow {...p} schemaId="second" value={5} />);
    fireEvent.keyUp(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(p.session.commitValue).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    fireEvent.keyUp(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(p.session.setValue).toHaveBeenLastCalledWith("second", "speed", 5.1);
    expect(p.session.commitValue).toHaveBeenCalledExactlyOnceWith(
      "second",
      "speed",
    );
  });
  it("commits toggle changes and sends triggers only as commands", () => {
    const p = props({
      id: "enabled",
      label: "Enabled",
      kind: "toggle",
      defaultValue: false,
    });
    const view = render(<InspectorControlRow {...p} />);
    fireEvent.click(screen.getByText("On"));
    expect(p.session.setValue).toHaveBeenCalledWith("first", "enabled", true);
    expect(p.session.commitValue).toHaveBeenCalledWith("first", "enabled");
    view.rerender(
      <InspectorControlRow
        {...p}
        control={{ id: "run", label: "Replay", kind: "trigger" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Replay/ }));
    expect(p.session.fireTrigger).toHaveBeenCalledExactlyOnceWith(
      "first",
      "run",
    );
    expect(p.session.setValue).toHaveBeenCalledTimes(1);
  });
  it("preserves spring siblings, rejects an empty draft, and commits on blur", () => {
    const p = props({
      id: "spring",
      label: "Spring",
      kind: "spring",
      defaultValue: { damping: 10, stiffness: 100, mass: 2 },
    });
    render(<InspectorControlRow {...p} />);
    fireEvent.change(screen.getByLabelText("damping"), {
      target: { value: "" },
    });
    expect(p.session.setValue).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("damping"), {
      target: { value: "15" },
    });
    expect(p.session.setValue).toHaveBeenCalledExactlyOnceWith(
      "first",
      "spring",
      { damping: 15, stiffness: 100, mass: 2 },
    );
    fireEvent.blur(screen.getByLabelText("damping"));
    expect(p.session.commitValue).toHaveBeenCalledExactlyOnceWith(
      "first",
      "spring",
    );
  });
  it("preserves bezier tuple shape and sends out-of-range values to core validation unchanged", () => {
    const p = props({
      id: "curve",
      label: "Curve",
      kind: "bezier",
      defaultValue: [0.2, 0.3, 0.4, 0.5],
    });
    render(<InspectorControlRow {...p} />);
    fireEvent.change(screen.getByLabelText("x1"), { target: { value: "2" } });
    expect(p.session.setValue).toHaveBeenCalledWith(
      "first",
      "curve",
      [2, 0.3, 0.4, 0.5],
    );
  });
  it("removes a color popover when stale and remounts with current values on recovery", () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      new DOMRect(0, 0, 300, 36),
    ] as unknown as DOMRectList);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const p = props({
      id: "color",
      label: "Tint",
      kind: "color",
      defaultValue: "#123456",
    });
    const view = render(<InspectorControlRow {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /pick tint color/i }));
    expect(document.querySelector(".dialkit-color-popover")).not.toBeNull();
    view.rerender(<InspectorControlRow {...p} disabled />);
    expect(document.querySelector(".dialkit-color-popover")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(p.session.setValue).not.toHaveBeenCalled();
    view.rerender(<InspectorControlRow {...p} value="#abcdef" />);
    const input = screen.getByRole("textbox", { name: "Tint color value" });
    expect((input as HTMLInputElement).value).toBe("#abcdef");
    fireEvent.change(input, { target: { value: "#ffffff" } });
    expect(p.session.setValue).toHaveBeenCalledWith(
      "first",
      "color",
      "#ffffff",
    );
    expect(p.session.commitValue).toHaveBeenCalledWith("first", "color");
  });
  it("disables all controls while stale", () => {
    const p = props();
    render(<InspectorControlRow {...p} disabled />);
    expect(screen.queryByRole("slider")).toBeNull();
    expect(
      screen.getByText("Speed").parentElement?.getAttribute("aria-disabled"),
    ).toBe("true");
  });
});

it("rejects exact numeric input through a real session without patching or committing a clamped value", async () => {
  const { createPanelSession } = await import("@runtime-inspector/panel-core");
  const socket = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    onopen: null as (() => void) | null,
    onclose: null,
    onerror: null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
  };
  const session = createPanelSession({
    url: "ws://test",
    createSocket: () => socket,
  });
  session.connect();
  socket.onopen?.();
  socket.onmessage?.({
    data: JSON.stringify({
      type: "schema.publish",
      schema: {
        id: "first",
        title: "Test",
        groups: [{ id: "main", label: "Main", controls: [slider] }],
      },
    }),
  });
  socket.send.mockClear();
  render(<InspectorControlRow {...props()} session={session} />);
  fireEvent.keyDown(screen.getByRole("slider"), { key: "Enter" });
  expect(document.activeElement).toBe(
    screen.getByLabelText("Speed exact value"),
  );
  expect(document.querySelector(".dialkit-slider-input")).toBeNull();
  fireEvent.change(screen.getByLabelText("Speed exact value"), {
    target: { value: "99" },
  });
  fireEvent.blur(screen.getByLabelText("Speed exact value"));
  expect(session.getState().notice).toContain("Invalid value for Speed");
  expect(session.getState().values.first.speed).toBe(1);
  expect(socket.send).not.toHaveBeenCalled();
  session.dispose();
});

it("closes transient color editing when a schema republishes the same control id", () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 300, 36),
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const p = props({
    id: "tint",
    label: "Tint",
    kind: "color",
    defaultValue: "#123456",
  });
  const view = render(<InspectorControlRow {...p} />);
  fireEvent.click(screen.getByRole("button", { name: /pick tint color/i }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  view.rerender(
    <InspectorControlRow {...p} control={{ ...p.control }} value="#abcdef" />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    (screen.getByLabelText("Tint color value") as HTMLInputElement).value,
  ).toBe("#abcdef");
});
