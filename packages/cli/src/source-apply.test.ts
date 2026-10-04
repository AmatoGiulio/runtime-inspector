import { parse as babelParse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import type { LiteralAnchor, SourceAnchor, SourceApplyRequest } from "@runtime-inspector/protocol";
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

type AnchorRequest = SourceApplyRequest & { anchor: SourceAnchor };

function makeRequest(overrides: Partial<AnchorRequest> = {}): SourceApplyRequest {
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

describe("applySourceRequests with literal anchors (RFC 0007)", () => {
  const FILE = `${ROOT}/src/WelcomeDemo.tsx`;
  const IMPORT = 'import { useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";';

  function demo(imports: string, titleLine: string, logoLine: string): string {
    return [
      imports,
      "",
      "export function WelcomeDemo() {",
      "  const titleY = useSharedValue(24);",
      "  const logo = useSharedValue(0);",
      "  function play() {",
      `    ${titleLine}`,
      `    ${logoLine}`,
      "  }",
      "  return play;",
      "}",
      ""
    ].join("\n");
  }

  const TITLE = "titleY.value = withDelay(140, withTiming(0, { duration: 380 }));";
  const LOGO = "logo.value = withSpring(1, { damping: 14, stiffness: 160, mass: 0.5 });";
  const ORIGINAL = demo(IMPORT, TITLE, LOGO);

  function makeLiteral(overrides: Partial<LiteralAnchor> = {}): LiteralAnchor {
    return {
      file: "src/WelcomeDemo.tsx",
      line: 7,
      column: 4,
      enclosure: ["WelcomeDemo", "play"],
      target: "titleY.value",
      callee: "withTiming",
      parameter: "duration",
      init: "380",
      ...overrides
    };
  }

  /** A logo (line 8) spring literal. */
  function logoLiteral(overrides: Partial<LiteralAnchor> = {}): LiteralAnchor {
    return makeLiteral({ line: 8, target: "logo.value", callee: "withSpring", ...overrides });
  }

  function literalRequest(literal: LiteralAnchor, value: number, controlId?: string): SourceApplyRequest {
    return {
      controlId: controlId ?? `${literal.target}:${literal.parameter}`,
      kind: "slider",
      literal,
      value
    };
  }

  async function run(source: string, requests: SourceApplyRequest[], parse?: (code: string) => unknown) {
    const fs = createFakeFs({ [FILE]: source });
    let writes = 0;
    const results = await applySourceRequests(requests, {
      rootDir: ROOT,
      readFile: fs.readFile,
      writeFile: async (path, content) => {
        writes += 1;
        await fs.writeFile(path, content);
      },
      ...(parse ? { parse } : {})
    });
    return { results, output: fs.store.get(FILE) as string, writes };
  }

  it("replaces a timing duration, leaving every other byte identical", async () => {
    const { results, output } = await run(ORIGINAL, [literalRequest(makeLiteral(), 420)]);

    expect(results).toEqual([{ controlId: "titleY.value:duration", ok: true, written: "420", previous: "380" }]);
    expect(output).toBe(
      demo(IMPORT, "titleY.value = withDelay(140, withTiming(0, { duration: 420 }));", LOGO)
    );
  });

  it("replaces the delay literal of a delayed call", async () => {
    const { results, output } = await run(ORIGINAL, [
      literalRequest(makeLiteral({ parameter: "delay", init: "140" }), 180)
    ]);

    expect(results).toEqual([{ controlId: "titleY.value:delay", ok: true, written: "180", previous: "140" }]);
    expect(output).toBe(
      demo(IMPORT, "titleY.value = withDelay(180, withTiming(0, { duration: 380 }));", LOGO)
    );
  });

  it("replaces all three spring literals of one call in one write", async () => {
    const { results, output, writes } = await run(ORIGINAL, [
      literalRequest(logoLiteral({ parameter: "damping", init: "14" }), 18.5),
      literalRequest(logoLiteral({ parameter: "stiffness", init: "160" }), 200),
      literalRequest(logoLiteral({ parameter: "mass", init: "0.5" }), 1)
    ]);

    expect(results).toEqual([
      { controlId: "logo.value:damping", ok: true, written: "18.5", previous: "14" },
      { controlId: "logo.value:stiffness", ok: true, written: "200", previous: "160" },
      { controlId: "logo.value:mass", ok: true, written: "1", previous: "0.5" }
    ]);
    expect(writes).toBe(1);
    expect(output).toBe(
      demo(IMPORT, TITLE, "logo.value = withSpring(1, { damping: 18.5, stiffness: 200, mass: 1 });")
    );
  });

  it("matches the target text ignoring whitespace and a quoted config key", async () => {
    const source = demo(IMPORT, 'titleY . value = withTiming(0, { "duration": 380 });', LOGO);
    const { results, output } = await run(source, [literalRequest(makeLiteral(), 400)]);

    expect(results[0]).toMatchObject({ ok: true, written: "400", previous: "380" });
    expect(output).toBe(demo(IMPORT, 'titleY . value = withTiming(0, { "duration": 400 });', LOGO));
  });

  describe("delay on a bare call", () => {
    const bareLiteral = logoLiteral({ parameter: "delay", init: null });

    it("wraps the call with an existing withDelay import", async () => {
      const { results, output } = await run(ORIGINAL, [literalRequest(bareLiteral, 120)]);

      expect(results).toEqual([{ controlId: "logo.value:delay", ok: true, written: "120", previous: "0" }]);
      expect(output).toBe(
        demo(
          IMPORT,
          TITLE,
          "logo.value = withDelay(120, withSpring(1, { damping: 14, stiffness: 160, mass: 0.5 }));"
        )
      );
    });

    it("uses the local name of an aliased withDelay import", async () => {
      const imports =
        'import { useSharedValue, withDelay as wd, withSpring, withTiming } from "react-native-reanimated";';
      const { output } = await run(demo(imports, TITLE, LOGO), [literalRequest(bareLiteral, 120)]);

      expect(output).toBe(
        demo(imports, TITLE, "logo.value = wd(120, withSpring(1, { damping: 14, stiffness: 160, mass: 0.5 }));")
      );
    });

    it("uses the callee's object for a member callee and leaves imports alone", async () => {
      const imports = 'import * as Reanimated from "react-native-reanimated";';
      const logo = "logo.value = Reanimated.withSpring(1, { damping: 14 });";
      const { results, output } = await run(demo(imports, TITLE, logo), [literalRequest(bareLiteral, 90)]);

      expect(results[0]).toMatchObject({ ok: true, written: "90", previous: "0" });
      expect(output).toBe(
        demo(imports, TITLE, "logo.value = Reanimated.withDelay(90, Reanimated.withSpring(1, { damping: 14 }));")
      );
    });

    it("adds withDelay to the first value import from Reanimated when missing", async () => {
      const imports = [
        'import type { SharedValue } from "react-native-reanimated";',
        'import { useSharedValue, withSpring, withTiming } from "react-native-reanimated";',
        'import { Easing } from "react-native-reanimated";'
      ].join("\n");
      const { output } = await run(demo(imports, TITLE, LOGO), [literalRequest(bareLiteral, 120)]);

      expect(output).toBe(
        demo(
          [
            'import type { SharedValue } from "react-native-reanimated";',
            'import { useSharedValue, withSpring, withTiming, withDelay } from "react-native-reanimated";',
            'import { Easing } from "react-native-reanimated";'
          ].join("\n"),
          TITLE,
          "logo.value = withDelay(120, withSpring(1, { damping: 14, stiffness: 160, mass: 0.5 }));"
        )
      );
    });

    it("gives a default-only import a named withDelay", async () => {
      const imports = [
        'import Animated from "react-native-reanimated";',
        'import { useSharedValue, withSpring, withTiming } from "./motion";'
      ].join("\n");
      const { output } = await run(demo(imports, TITLE, LOGO), [literalRequest(bareLiteral, 120)]);

      expect(output.split("\n")[0]).toBe('import Animated, { withDelay } from "react-native-reanimated";');
      expect(output).toContain("logo.value = withDelay(120, withSpring(1,");
    });

    it("reports DECLARATION_MISSING without a value import from Reanimated", async () => {
      const imports = 'import { useSharedValue, withSpring, withTiming } from "./motion";';
      const source = demo(imports, TITLE, LOGO);
      const { results, output, writes } = await run(source, [literalRequest(bareLiteral, 120)]);

      expect(results[0]).toMatchObject({ ok: false, code: "DECLARATION_MISSING" });
      expect((results[0] as { message?: string }).message).toContain("react-native-reanimated");
      expect(output).toBe(source);
      expect(writes).toBe(0);
    });

    it("writes nothing for a delay of 0", async () => {
      const { results, output, writes } = await run(ORIGINAL, [literalRequest(bareLiteral, 0)]);

      expect(results).toEqual([{ controlId: "logo.value:delay", ok: true, written: "0", previous: "0" }]);
      expect(output).toBe(ORIGINAL);
      expect(writes).toBe(0);
    });

    it("adds the withDelay specifier once for two wraps in one file", async () => {
      const imports = 'import { useSharedValue, withSpring, withTiming } from "react-native-reanimated";';
      const title = "titleY.value = withTiming(0, { duration: 380 });";
      const { results, output } = await run(demo(imports, title, LOGO), [
        literalRequest(makeLiteral({ parameter: "delay", init: null }), 140),
        literalRequest(bareLiteral, 60)
      ]);

      expect(results.every((result) => result.ok)).toBe(true);
      expect(output).toBe(
        demo(
          'import { useSharedValue, withSpring, withTiming, withDelay } from "react-native-reanimated";',
          "titleY.value = withDelay(140, withTiming(0, { duration: 380 }));",
          "logo.value = withDelay(60, withSpring(1, { damping: 14, stiffness: 160, mass: 0.5 }));"
        )
      );
    });

    it("wraps the updated call when its duration changes in the same batch", async () => {
      const title = "titleY.value = withTiming(0, { duration: 380 });";
      const { results, output } = await run(demo(IMPORT, title, LOGO), [
        literalRequest(makeLiteral({ parameter: "delay", init: null }), 140),
        literalRequest(makeLiteral(), 420)
      ]);

      expect(results).toEqual([
        { controlId: "titleY.value:delay", ok: true, written: "140", previous: "0" },
        { controlId: "titleY.value:duration", ok: true, written: "420", previous: "380" }
      ]);
      expect(output).toBe(demo(IMPORT, "titleY.value = withDelay(140, withTiming(0, { duration: 420 }));", LOGO));
    });
  });

  it("applies anchor and literal requests in one file and one batch", async () => {
    const { results, output, writes } = await run(ORIGINAL, [
      {
        controlId: "titleY",
        kind: "slider",
        anchor: {
          file: "src/WelcomeDemo.tsx",
          line: 4,
          column: 8,
          enclosure: ["WelcomeDemo"],
          name: "titleY",
          init: "24"
        },
        value: 32
      },
      literalRequest(makeLiteral(), 420)
    ]);

    expect(results).toEqual([
      { controlId: "titleY", ok: true, written: "32", previous: "24" },
      { controlId: "titleY.value:duration", ok: true, written: "420", previous: "380" }
    ]);
    expect(writes).toBe(1);
    expect(output).toBe(
      demo(IMPORT, "titleY.value = withDelay(140, withTiming(0, { duration: 420 }));", LOGO).replace(
        "useSharedValue(24)",
        "useSharedValue(32)"
      )
    );
  });

  it("rejects a second edit of the same literal as an overlapping edit", async () => {
    const { results, output } = await run(ORIGINAL, [
      literalRequest(makeLiteral(), 420, "first"),
      literalRequest(makeLiteral(), 500, "second")
    ]);

    expect(results[0]).toMatchObject({ controlId: "first", ok: true });
    expect(results[1]).toEqual({ controlId: "second", ok: false, code: "WRITE_FAILURE", message: "overlapping edit" });
    expect(output).toContain("{ duration: 420 }");
  });

  describe("error codes", () => {
    it("PARSE_FAILURE: the file no longer parses", async () => {
      const { results } = await run("function WelcomeDemo( {", [literalRequest(makeLiteral(), 420)]);
      expect(results[0]).toMatchObject({ ok: false, code: "PARSE_FAILURE" });
    });

    it.each([
      ["another target", makeLiteral({ target: "subtitleY.value" })],
      ["another enclosure", makeLiteral({ enclosure: ["WelcomeDemo"] })],
      ["another callee", makeLiteral({ callee: "withSpring" })]
    ])("DECLARATION_MISSING: no assignment with %s", async (_label, literal) => {
      const { results, writes } = await run(ORIGINAL, [literalRequest(literal, 420)]);
      expect(results[0]).toMatchObject({ ok: false, code: "DECLARATION_MISSING" });
      expect(writes).toBe(0);
    });

    it.each([
      ["a named constant", "titleY.value = withDelay(140, withTiming(0, { duration: DURATION }));", makeLiteral()],
      ["a spread config", "titleY.value = withDelay(140, withTiming(0, { ...base, duration: 380 }));", makeLiteral()],
      [
        "a computed delay",
        "titleY.value = withDelay(stagger * 2, withTiming(0, { duration: 380 }));",
        makeLiteral({ parameter: "delay", init: "140" })
      ]
    ])("DECLARATION_MISSING: the parameter is %s", async (_label, title, literal) => {
      const source = demo(IMPORT, title, LOGO);
      const { results, output } = await run(source, [literalRequest(literal, 420)]);
      expect(results[0]).toMatchObject({ ok: false, code: "DECLARATION_MISSING" });
      expect(output).toBe(source);
    });

    it("DECLARATION_MOVED: several matches, none at the recorded line/column", async () => {
      const source = demo(IMPORT, TITLE, "titleY.value = withTiming(0, { duration: 380 });");
      const { results } = await run(source, [literalRequest(makeLiteral({ line: 99 }), 420)]);
      expect(results[0]).toMatchObject({ ok: false, code: "DECLARATION_MOVED" });
    });

    it("picks the match at the recorded line/column among several", async () => {
      const source = demo(IMPORT, TITLE, "titleY.value = withTiming(0, { duration: 380 });");
      const { results, output } = await run(source, [literalRequest(makeLiteral({ line: 8 }), 420)]);
      expect(results[0]).toMatchObject({ ok: true, written: "420" });
      expect(output).toBe(demo(IMPORT, TITLE, "titleY.value = withTiming(0, { duration: 420 });"));
    });

    it("DECLARATION_AMBIGUOUS: several matches even at the recorded line/column", async () => {
      // Two assignments cannot share a position in one parse; duplicate the statement in the AST.
      const parse = (code: string) => {
        const ast = babelParse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
        const play = (ast.program.body[1] as any).declaration.body.body[2].body.body;
        play.push(play[0]);
        return ast;
      };
      const { results } = await run(ORIGINAL, [literalRequest(makeLiteral(), 420)], parse);
      expect(results[0]).toMatchObject({ ok: false, code: "DECLARATION_AMBIGUOUS" });
    });

    it("EXPRESSION_MISMATCH: the literal was edited since the app was built", async () => {
      const { results, output } = await run(ORIGINAL, [literalRequest(makeLiteral({ init: "300" }), 420)]);
      expect(results[0]).toMatchObject({ ok: false, code: "EXPRESSION_MISMATCH" });
      expect(output).toBe(ORIGINAL);
    });

    it("EXPRESSION_MISMATCH: a bare call now has a withDelay", async () => {
      const { results, output } = await run(ORIGINAL, [
        literalRequest(makeLiteral({ parameter: "delay", init: null }), 200)
      ]);
      expect(results[0]).toMatchObject({ ok: false, code: "EXPRESSION_MISMATCH" });
      expect(output).toBe(ORIGINAL);
    });

    it("EXPRESSION_MISMATCH: a delayed call is now bare", async () => {
      const { results, output } = await run(ORIGINAL, [
        literalRequest(logoLiteral({ parameter: "delay", init: "100" }), 200)
      ]);
      expect(results[0]).toMatchObject({ ok: false, code: "EXPRESSION_MISMATCH" });
      expect(output).toBe(ORIGINAL);
    });

    it("WRITE_FAILURE: the filesystem rejects the write", async () => {
      const fs = createFakeFs({ [FILE]: ORIGINAL });
      const results = await applySourceRequests([literalRequest(makeLiteral(), 420)], {
        rootDir: ROOT,
        readFile: fs.readFile,
        writeFile: async () => {
          throw new Error("EACCES");
        }
      });
      expect(results[0]).toEqual({
        controlId: "titleY.value:duration",
        ok: false,
        code: "WRITE_FAILURE",
        message: "EACCES"
      });
    });

    it("WRITE_FAILURE: the literal file escapes the workspace root", async () => {
      const { results } = await run(ORIGINAL, [
        literalRequest(makeLiteral({ file: "../outside/WelcomeDemo.tsx" }), 420)
      ]);
      expect(results[0]).toMatchObject({ ok: false, code: "WRITE_FAILURE" });
      expect((results[0] as { message?: string }).message).toContain("path outside workspace root");
    });
  });
});
