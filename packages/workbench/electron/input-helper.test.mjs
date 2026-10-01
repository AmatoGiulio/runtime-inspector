import test from "node:test";
import assert from "node:assert/strict";
import { parseDesktopWindowId } from "./input-helper.mjs";

test("parseDesktopWindowId reads Electron window source ids", () => {
  assert.equal(parseDesktopWindowId("window:4387:0"), 4387);
  assert.equal(parseDesktopWindowId("window:1:17"), 1);
});

test("parseDesktopWindowId rejects non-window sources", () => {
  assert.equal(parseDesktopWindowId("screen:0:0"), undefined);
  assert.equal(parseDesktopWindowId("window:not-a-number:0"), undefined);
  assert.equal(parseDesktopWindowId(undefined), undefined);
});
