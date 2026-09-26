import { describe, expect, it } from "vitest";
import type { SourceAnchor, SourceApplyRequest } from "@runtime-inspector/protocol";
import { applySourceRequests } from "./source-apply";

const ROOT = "/repo";

function createFakeFs(files: Record<string, string>) {
  const store = new Map(Object.entries(files));
  return {
    store,
    readFile: async (path: string): Promise<string> => {
      if (!store.has(path)) {
        throw new Error(`ENOENT: no such file, open '${path}'`);
      }
      return store.get(path) as string;
    },
    writeFile: async (path: string, content: string): Promise<void> => {
      store.set(path, content);
    }
  };
}

function makeAnchor(overrides: Partial<SourceAnchor> = {}): SourceAnchor {
  return {
    file: "src/Card.tsx",
    line: 2,
    column: 8,
    enclosure: ["Card"],
    name: "moveX",
    init: "0",
    ...overrides
  };
}

function makeRequest(overrides: Partial<SourceApplyRequest> = {}): SourceApplyRequest {
  return {
    controlId: "moveX",
    kind: "slider",
    anchor: makeAnchor(),
    value: 42,
    ...overrides
  };
}

describe("applySourceRequests", () => {
  it("applies a clean edit, leaving the rest of the file byte-for-byte identical", async () => {
    const original = ["function Card() {", "  const moveX = useSharedValue(0);", "  return moveX;", "}", ""].join(
      "\n"
    );
    const fs = createFakeFs({ [`${ROOT}/src/Card.tsx`]: original });

    const results = await applySourceRequests([makeRequest()], {
      rootDir: ROOT,
      readFile: fs.readFile,
      writeFile: fs.writeFile
    });

    expect(results).toEqual([{ controlId: "moveX", ok: true, written: "42", previous: "0" }]);

    const expected = original.replace("useSharedValue(0)", "useSharedValue(42)");
    expect(fs.store.get(`${ROOT}/src/Card.tsx`)).toBe(expected);
  });

  it("applies when the declaration moved to a different line but is the only candidate", async () => {
    const original = ["function Card() {", "  const moveX = useSharedValue(0);", "  return moveX;", "}", ""].join(
      "\n"
    );
    const fs = createFakeFs({ [`${ROOT}/src/Card.tsx`]: original });

    // Stale anchor line/column: the declaration is unique by name+enclosure,
    // so the tiebreaker is never consulted and the apply still succeeds.
    const request = makeRequest({ anchor: makeAnchor({ line: 999, column: 999 }) });

    const results = await applySourceRequests([request], {
      rootDir: ROOT,
      readFile: fs.readFile,
      writeFile: fs.writeFile
    });

    expect(results).toEqual([{ controlId: "moveX", ok: true, written: "42", previous: "0" }]);
  });

  // Two `function Card` declarations in separate block scopes (each inside
  // its own `if` block) so the file stays parseable (a top-level duplicate
  // `function Card` binding would be a redeclaration syntax error under
  // ESM/strict mode) while still producing two candidates with the exact
  // same enclosure chain (`["Card"]`), which is what the anchor's
  // line/column tiebreaker exists to disambiguate.
  const duplicateNameSource = [
    "if (true) {",
    "  function Card() {",
    "    const moveX = useSharedValue(0);",
    "  }",
    "}",
    "",
    "if (true) {",
    "  function Card() {",
    "    const moveX = useSharedValue(1);",
    "  }",
    "}",
    ""
  ].join("\n");

  it("resolves a duplicate name in the same enclosure via the line/column tiebreaker", async () => {
    const fs = createFakeFs({ [`${ROOT}/src/Card.tsx`]: duplicateNameSource });

    // Second occurrence: line 9, column 10.
    const request = makeRequest({
      anchor: makeAnchor({ line: 9, column: 10, init: "1" }),
      value: 99
    });

    const results = await applySourceRequests([request], {
      rootDir: ROOT,
      readFile: fs.readFile,
      writeFile: fs.writeFile
    });

    expect(results).toEqual([{ controlId: "moveX", ok: true, written: "99", previous: "1" }]);

    const written = fs.store.get(`${ROOT}/src/Card.tsx`) as string;
    expect(written).toContain("useSharedValue(0)"); // first occurrence untouched
    expect(written).toContain("useSharedValue(99)"); // second occurrence rewritten
  });

  it("reports DECLARATION_MOVED for a duplicate name whose line no longer matches either occurrence", async () => {
    const fs = createFakeFs({ [`${ROOT}/src/Card.tsx`]: duplicateNameSource });

    const request = makeRequest({ anchor: makeAnchor({ line: 999, column: 999, init: "1" }) });

    const results = await applySourceRequests([request], {
      rootDir: ROOT,
      readFile: fs.readFile,
      writeFile: fs.writeFile
    });

    expect(results).toEqual([{ controlId: "moveX", ok: false, code: "DECLARATION_MOVED" }]);
  });

  it("reports EXPRESSION_MISMATCH when the current initializer text no longer matches the anchor", async () => {
    const original = ["function Card() {", "  const moveX = useSharedValue(0);", "}", ""].join("\n");
    const fs = createFakeFs({ [`${ROOT}/src/Card.tsx`]: original });

    // Anchor claims the initializer was "5"; the file actually still has "0".
    const request = makeRequest({ anchor: makeAnchor({ init: "5" }) });

    const results = await applySourceRequests([request], {
      rootDir: ROOT,
      readFile: fs.readFile,
      writeFile: fs.writeFile
    });

    expect(results).toEqual([{ controlId: "moveX", ok: false, code: "EXPRESSION_MISMATCH" }]);
    expect(fs.store.get(`${ROOT}/src/Card.tsx`)).toBe(original);
  });

  it("reports PARSE_FAILURE for a file that no longer parses", async () => {
    const fs = createFakeFs({ [`${ROOT}/src/Card.tsx`]: "function Card( { const moveX = ;" });

    const results = await applySourceRequests([makeRequest()], {
      rootDir: ROOT,
      readFile: fs.readFile,
      writeFile: fs.writeFile
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ controlId: "moveX", ok: false, code: "PARSE_FAILURE" });
  });

  it("reports DECLARATION_MISSING when the anchor file does not exist", async () => {
    const fs = createFakeFs({});

    const results = await applySourceRequests([makeRequest()], {
      rootDir: ROOT,
      readFile: fs.readFile,
      writeFile: fs.writeFile
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ controlId: "moveX", ok: false, code: "DECLARATION_MISSING" });
    expect((results[0] as { message?: string }).message).toContain(`${ROOT}/src/Card.tsx`);
  });

  it("reports WRITE_FAILURE for a path that escapes the workspace root", async () => {
    const fs = createFakeFs({});

    const request = makeRequest({ anchor: makeAnchor({ file: "../../etc/passwd" }) });

    const results = await applySourceRequests([request], {
      rootDir: ROOT,
      readFile: fs.readFile,
      writeFile: fs.writeFile
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ controlId: "moveX", ok: false, code: "WRITE_FAILURE" });
    expect((results[0] as { message?: string }).message).toContain("path outside workspace root");
  });

  it("serializes spring and bezier values in the serializer's format", async () => {
    const original = [
      "function Card() {",
      "  const spring = useSharedValue({ damping: 10, stiffness: 100 });",
      "  const curve = useSharedValue([0.4, 0, 0.2, 1]);",
      "}",
      ""
    ].join("\n");
    const fs = createFakeFs({ [`${ROOT}/src/Card.tsx`]: original });

    const springRequest = makeRequest({
      controlId: "spring",
      kind: "spring",
      anchor: makeAnchor({
        line: 2,
        column: 8,
        name: "spring",
        init: "{ damping: 10, stiffness: 100 }"
      }),
      value: { damping: 20, stiffness: 200, mass: 2 }
    });
    const bezierRequest = makeRequest({
      controlId: "curve",
      kind: "bezier",
      anchor: makeAnchor({
        line: 3,
        column: 8,
        name: "curve",
        init: "[0.4, 0, 0.2, 1]"
      }),
      value: [0.1, 0.2, 0.3, 0.4]
    });

    const results = await applySourceRequests([springRequest, bezierRequest], {
      rootDir: ROOT,
      readFile: fs.readFile,
      writeFile: fs.writeFile
    });

    expect(results).toEqual([
      {
        controlId: "spring",
        ok: true,
        written: "{ damping: 20, stiffness: 200, mass: 2 }",
        previous: "{ damping: 10, stiffness: 100 }"
      },
      {
        controlId: "curve",
        ok: true,
        written: "[0.1, 0.2, 0.3, 0.4]",
        previous: "[0.4, 0, 0.2, 1]"
      }
    ]);
  });

  it("applies two requests to the same file, both taking effect", async () => {
    const original = [
      "function Card() {",
      "  const moveX = useSharedValue(0);",
      "  const moveY = useSharedValue(10);",
      "}",
      ""
    ].join("\n");
    const fs = createFakeFs({ [`${ROOT}/src/Card.tsx`]: original });

    const requestX = makeRequest({
      controlId: "moveX",
      anchor: makeAnchor({ line: 2, column: 8, name: "moveX", init: "0" }),
      value: 1
    });
    const requestY = makeRequest({
      controlId: "moveY",
      anchor: makeAnchor({ line: 3, column: 8, name: "moveY", init: "10" }),
      value: 20
    });

    const results = await applySourceRequests([requestX, requestY], {
      rootDir: ROOT,
      readFile: fs.readFile,
      writeFile: fs.writeFile
    });

    expect(results).toEqual([
      { controlId: "moveX", ok: true, written: "1", previous: "0" },
      { controlId: "moveY", ok: true, written: "20", previous: "10" }
    ]);

    const written = fs.store.get(`${ROOT}/src/Card.tsx`) as string;
    expect(written).toContain("useSharedValue(1)");
    expect(written).toContain("useSharedValue(20)");
  });
});
