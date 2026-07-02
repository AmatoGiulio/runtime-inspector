import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isValidControlValue,
  parseRIPMessage,
  safeParseRIPMessage,
  type InspectorControl
} from "./index";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, "..", "fixtures");
const validDir = join(fixturesRoot, "valid");
const invalidDir = join(fixturesRoot, "invalid");

function loadJsonFiles(dir: string): Array<{ name: string; content: unknown }> {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      name,
      content: JSON.parse(readFileSync(join(dir, name), "utf-8"))
    }));
}

function isValueLevelFixture(
  content: unknown
): content is { controlKind: string; control: InspectorControl; value: unknown } {
  return (
    typeof content === "object" &&
    content !== null &&
    "control" in content &&
    "value" in content &&
    "controlKind" in content
  );
}

describe("conformance fixtures: valid", () => {
  const files = loadJsonFiles(validDir);

  it("finds at least one fixture per message type", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const { name, content } of files) {
    it(`parses ${name} via parseRIPMessage`, () => {
      expect(() => parseRIPMessage(content)).not.toThrow();
    });

    it(`round-trips ${name} via safeParseRIPMessage`, () => {
      const message = safeParseRIPMessage(JSON.stringify(content));
      expect(message).toBeDefined();
    });
  }
});

describe("conformance fixtures: invalid", () => {
  const files = loadJsonFiles(invalidDir);

  it("has at least 8 invalid fixtures", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  for (const { name, content } of files) {
    if (isValueLevelFixture(content)) {
      it(`rejects value-level fixture ${name} via isValidControlValue`, () => {
        expect(isValidControlValue(content.control, content.value)).toBe(false);
      });
    } else {
      it(`rejects full-message fixture ${name} via safeParseRIPMessage`, () => {
        const message = safeParseRIPMessage(JSON.stringify(content));
        expect(message).toBeUndefined();
      });
    }
  }
});
