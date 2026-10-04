import { parseSync, transformSync, type TransformOptions } from "@babel/core";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import plugin from "./index";

function transform(code: string, envName: string = "development"): string {
  const result = transformSync(code, {
    filename: "test.tsx",
    presets: [["@babel/preset-typescript", { isTSX: true, allExtensions: true }]],
    plugins: [plugin],
    envName,
    babelrc: false,
    configFile: false
  });
  if (!result?.code) throw new Error("transform produced no output");
  return result.code;
}

function transformWithOpts(code: string, opts: Partial<TransformOptions>): string {
  const result = transformSync(code, {
    presets: [["@babel/preset-typescript", { isTSX: true, allExtensions: true }]],
    plugins: [plugin],
    envName: "development",
    babelrc: false,
    configFile: false,
    ...opts
  });
  if (!result?.code) throw new Error("transform produced no output");
  return result.code;
}

/** The normalized `literal` property an RFC 0007 binding descriptor carries. */
function literalProperty(fields: {
  file?: string;
  line?: number;
  column?: number;
  enclosure?: string[];
  target?: string;
  callee: string;
  parameter: string;
  init: string | null;
}): string {
  const enclosure = (fields.enclosure ?? []).map((entry) => `"${entry}"`).join(", ");
  const init = fields.init === null ? "null" : `"${fields.init}"`;
  return (
    `literal: { file: "${fields.file ?? "src/Card.tsx"}", line: ${fields.line ?? 9}, ` +
    `column: ${fields.column ?? 6}, enclosure: [${enclosure}], ` +
    `target: "${fields.target ?? "card.moveX.value"}", callee: "${fields.callee}", ` +
    `parameter: "${fields.parameter}", init: ${init} }`
  );
}

describe("runtime-inspector babel plugin", () => {
  it("transforms an annotated useSharedValue declaration and adds the auto-import", () => {
    const code = transform(`
      import { useSharedValue } from "react-native-reanimated";
      // @inspect min=-120 max=120 step=1 unit=px label="Move X"
      const moveX = useSharedValue(0);
    `);

    expect(code).toContain('import { __riInspect } from "@runtime-inspector/react-native"');
    const normalized = code.replace(/\s+/g, " ");
    expect(normalized).toContain(
      '__riInspect(useSharedValue(0), "moveX", { min: -120, max: 120, step: 1, unit: "px", label: "Move X", source: { file: "test.tsx", line: 4, column: 12, enclosure: [], name: "moveX", init: "0" } })'
    );
  });

  it("leaves an unannotated useSharedValue declaration untouched", () => {
    const code = transform(`
      import { useSharedValue } from "react-native-reanimated";
      const plain = useSharedValue(0);
    `);

    expect(code).not.toContain("__riInspect");
    expect(code).not.toContain(SOURCE_IMPORT);
  });

  it("throws a build-time error for a numeric initial value without min/max", () => {
    expect(() =>
      transform(`
        // @inspect label="Broken"
        const broken = useSharedValue(0);
      `)
    ).toThrow(/numeric initial value|min\/max|explicit range/i);
  });

  it("leaves code untouched in production env", () => {
    const source = `
      import { useSharedValue } from "react-native-reanimated";
      // @inspect min=-120 max=120
      const moveX = useSharedValue(0);
    `;
    const code = transform(source, "production");
    expect(code).not.toContain("__riInspect");
    expect(code).not.toContain(SOURCE_IMPORT);
  });

  it("supports a trailing-comment directive variant", () => {
    const code = transform(`
      import { useSharedValue } from "react-native-reanimated";
      const cardRadius = useSharedValue(8); // @inspect min=8 max=48
    `);

    expect(code).toContain("__riInspect");
    expect(code).toContain('"cardRadius"');
    expect(code).toContain(SOURCE_IMPORT);
  });

  it("parses a quoted label with spaces", () => {
    const code = transform(`
      import { useSharedValue } from "react-native-reanimated";
      // @inspect min=0 max=1 label="Backdrop Opacity"
      const opacity = useSharedValue(0);
    `);

    expect(code).toContain('label: "Backdrop Opacity"');
  });

  it("does not require min/max for a boolean initial value", () => {
    const code = transform(`
      import { useSharedValue } from "react-native-reanimated";
      // @inspect label="Enabled"
      const enabled = useSharedValue(true);
    `);

    expect(code).toContain("__riInspect");
    expect(code).not.toThrow;
  });

  it("adds the specifier to an existing import from the runtime package", () => {
    const code = transform(`
      import { useInspector } from "@runtime-inspector/react-native";
      import { useSharedValue } from "react-native-reanimated";
      useInspector("panel", {});
      // @inspect min=0 max=10
      const value = useSharedValue(0);
    `);

    const importLines = code.split("\n").filter((line) => line.includes(SOURCE_IMPORT));
    expect(importLines).toHaveLength(1);
    expect(importLines[0]).toContain("useInspector");
    expect(importLines[0]).toContain("__riInspect");
  });

  it("embeds a source anchor with file/line/column/name relative to the babel root", () => {
    const code = transformWithOpts(
      `
      import { useSharedValue } from "react-native-reanimated";
      // @inspect min=-120 max=120
      const moveX = useSharedValue(0);
    `,
      { filename: "/repo/src/Card.tsx", root: "/repo" }
    );

    const normalized = code.replace(/\s+/g, " ");
    expect(normalized).toContain('file: "src/Card.tsx"');
    expect(normalized).toMatch(/line: \d+/);
    expect(normalized).toMatch(/column: \d+/);
    expect(normalized).toContain('name: "moveX"');
    expect(normalized).toContain("enclosure: []");
    expect(normalized).toContain('init: "0"');

    const lineMatch = /line: (\d+)/.exec(normalized);
    const columnMatch = /column: (\d+)/.exec(normalized);
    expect(lineMatch?.[1]).toBe("4");
    expect(columnMatch?.[1]).toBe("12");
  });

  it("captures the enclosure chain for a nested named component", () => {
    const code = transformWithOpts(
      `
      import { useSharedValue } from "react-native-reanimated";
      function Outer() {
        const Inner = () => {
          // @inspect min=0 max=10
          const value = useSharedValue(0);
          return value;
        };
        return Inner;
      }
    `,
      { filename: "/repo/src/Card.tsx", root: "/repo" }
    );

    const normalized = code.replace(/\s+/g, " ");
    expect(normalized).toContain('enclosure: ["Outer", "Inner"]');
  });

  it("keeps the init text faithful to the original source for non-trivial initializers", () => {
    const objectInitCode = transformWithOpts(
      `
      import { useSharedValue } from "react-native-reanimated";
      // @inspect min=0 max=1
      const spring = useSharedValue({ damping: 14, stiffness: 180 });
    `,
      { filename: "/repo/src/Card.tsx", root: "/repo" }
    );
    expect(objectInitCode.replace(/\s+/g, " ")).toContain(
      'init: "{ damping: 14, stiffness: 180 }"'
    );

    const negativeInitCode = transformWithOpts(
      `
      import { useSharedValue } from "react-native-reanimated";
      // @inspect min=-200 max=200
      const offset = useSharedValue(-120);
    `,
      { filename: "/repo/src/Card.tsx", root: "/repo" }
    );
    expect(negativeInitCode).toContain('init: "-120"');
  });

  it("omits the source field entirely when no filename is available", () => {
    const code = transformWithOpts(
      `
      import { useSharedValue } from "react-native-reanimated";
      // @inspect min=-120 max=120
      const moveX = useSharedValue(0);
    `,
      { filename: undefined }
    );

    expect(code).toContain("__riInspect");
    expect(code).not.toContain("source:");
    const normalized = code.replace(/\s+/g, " ");
    expect(normalized).toContain(
      '__riInspect(useSharedValue(0), "moveX", { min: -120, max: 120, label: "moveX" })'
    );
  });

  it("auto-wraps a direct withTiming assignment and associates its useInspector schema", () => {
    const code = transformWithOpts(
      `
      import { useInspector } from "@runtime-inspector/react-native";
      import { withTiming } from "react-native-reanimated";
      function Card() {
        const card = useInspector("card-transition", { moveX: { value: 0, min: -120, max: 120 } });
        function replay() {
          card.moveX.value = withTiming(-110, { duration: 260 });
        }
        return replay;
      }
    `,
      { filename: "/repo/src/Card.tsx", root: "/repo" }
    );

    const normalized = code.replace(/\s+/g, " ");
    expect(normalized).toContain(
      "__riObserveAnimation(__riAnimationStart(withTiming(-110, __riAnimationConfig({ duration: 260 }, ["
    );
    expect(normalized).toContain('schemaId: "card-transition"');
    expect(normalized).toContain('target: "card.moveX"');
    expect(normalized).toContain('animationKind: "timing"');
    expect(normalized).toContain("toValue: -110");
    expect(normalized).toContain("config: { duration: 260 }");
    expect(normalized).toContain('file: "src/Card.tsx"');
    expect(normalized).toContain('expression: "withTiming(-110, { duration: 260 })"');
  });

  it("auto-wraps a direct withSpring assignment", () => {
    const code = transformWithOpts(
      `
      import { useInspector } from "@runtime-inspector/react-native";
      import { withSpring } from "react-native-reanimated";
      function Card() {
        const card = useInspector("card-transition", { moveX: { value: 0, min: -120, max: 120 } });
        card.moveX.value = withSpring(0, { damping: 14, stiffness: 180 });
        return card;
      }
    `,
      { filename: "/repo/src/Card.tsx", root: "/repo" }
    );

    const normalized = code.replace(/\s+/g, " ");
    expect(normalized).toContain(
      "__riObserveAnimation(__riAnimationStart(withSpring(0, __riAnimationConfig({ damping: 14, stiffness: 180 }, ["
    );
    expect(normalized).toContain('schemaId: "card-transition"');
    expect(normalized).toContain('target: "card.moveX"');
    expect(normalized).toContain('animationKind: "spring"');
    expect(normalized).toContain("config: { damping: 14, stiffness: 180 }");
    expect(normalized).not.toContain('configControlId: "spring"');
  });

  it("associates annotated shared values with the auto schema", () => {
    const code = transformWithOpts(
      `
      import { useSharedValue, withTiming } from "react-native-reanimated";
      // @inspect min=0 max=1
      const opacity = useSharedValue(0);
      opacity.value = withTiming(1, { duration: 180 });
    `,
      { filename: "/repo/src/Card.tsx", root: "/repo" }
    );

    const normalized = code.replace(/\s+/g, " ");
    expect(normalized).toContain("__riInspect");
    expect(normalized).toContain("__riObserveAnimation");
    expect(normalized).toContain('schemaId: "auto"');
    expect(normalized).toContain('target: "opacity"');
  });

  it("resolves an aliased inspector spring config without evaluating it twice", () => {
    const code = transformWithOpts(
      `
      import { useInspector } from "@runtime-inspector/react-native";
      import { withSpring } from "react-native-reanimated";
      function Card() {
        const card = useInspector("card-transition", {
          moveX: { value: 0, min: -120, max: 120 },
          spring: { damping: 14, stiffness: 180, mass: 1 }
        });
        const spring = card.spring.value;
        card.moveX.value = withSpring(card.$targets.moveX, spring);
        return card;
      }
    `,
      { filename: "/repo/src/Card.tsx", root: "/repo" }
    );

    const normalized = code.replace(/\s+/g, " ");
    expect(normalized).toContain(
      "__riObserveAnimation(__riAnimationStart(withSpring(card.$targets.moveX, spring), {"
    );
    expect(normalized).toContain('configControlId: "spring"');
    expect(
      normalized.match(
        /__riObserveAnimation\(__riAnimationStart\(withSpring\(card\.\$targets\.moveX, spring\)/g
      )
    ).toHaveLength(1);
  });

  it("does not instrument assignments inside known UI-runtime callbacks", () => {
    const code = transformWithOpts(
      `
      import { useAnimatedStyle, withTiming } from "react-native-reanimated";
      function Card() {
        const opacity = { value: 0 };
        useAnimatedStyle(() => {
          opacity.value = withTiming(1, { duration: 180 });
          return { opacity: opacity.value };
        });
      }
    `,
      { filename: "/repo/src/Card.tsx", root: "/repo" }
    );

    expect(code).not.toContain("__riObserveAnimation");
    expect(code).toContain("withTiming(1");
  });

  it("leaves animation calls with an explicit callback untouched in the first spike", () => {
    const code = transformWithOpts(
      `
      import { useInspector } from "@runtime-inspector/react-native";
      import { withTiming } from "react-native-reanimated";
      const card = useInspector("card-transition", { moveX: { value: 0, min: -120, max: 120 } });
      card.moveX.value = withTiming(-110, { duration: 260 }, () => console.log("done"));
    `,
      { filename: "/repo/src/Card.tsx", root: "/repo" }
    );

    expect(code).not.toContain("__riObserveAnimation");
    expect(code).toContain("withTiming(-110");
  });

  it("does not instrument animation primitives in the runtime SDK itself", () => {
    const code = transformWithOpts(
      `
      import { withTiming } from "react-native-reanimated";
      value.value = withTiming(1, { duration: 200 });
    `,
      {
        filename: "/repo/packages/runtime-react-native/src/internal.ts",
        root: "/repo"
      }
    );

    expect(code).not.toContain("__riObserveAnimation");
  });

  describe("editable timing duration (RFC 0005 3b)", () => {
    const CARD_OPTS = { filename: "/repo/src/Card.tsx", root: "/repo" };

    function transformAssignment(assignment: string, envName: string = "development"): string {
      return transformWithOpts(
        `
      import { useInspector } from "@runtime-inspector/react-native";
      import { Easing, withSpring, withTiming } from "react-native-reanimated";
      const easing = Easing.out(Easing.cubic);
      const base = { easing };
      const d = 260;
      const timing = { duration: 260 };
      const card = useInspector("card-transition", { moveX: { value: 0, min: -120, max: 120 } });
      ${assignment}
    `,
        { ...CARD_OPTS, envName }
      ).replace(/\s+/g, " ");
    }

    it("wraps the config argument of an eligible timing call and references its control", () => {
      const normalized = transformAssignment(
        "card.moveX.value = withTiming(-110, { duration: 260, easing });"
      );
      const controlId = "src/Card.tsx:9:6:timing:card.moveX:duration";

      expect(normalized).toContain(
        "card.moveX.value = __riObserveAnimation(__riAnimationStart(withTiming(-110, __riAnimationConfig({ duration: 260, easing }, [{ " +
          `key: "duration", controlId: "${controlId}", label: "card.moveX duration", ` +
          'declared: 260, min: 0, max: 10000, step: 1, unit: "ms", ' +
          literalProperty({ callee: "withTiming", parameter: "duration", init: "260" }) +
          " }])), {"
      );
      expect(normalized).toContain(
        `parameterControls: { duration: { schemaId: "auto", controlId: "${controlId}" } }`
      );
      // The rest of the meta is unchanged: literal config and original expression text.
      expect(normalized).toContain("config: { duration: 260 }");
      expect(normalized).toContain('expression: "withTiming(-110, { duration: 260, easing })"');

      const importStatements = normalized.match(/import \{[^}]*\} from "@runtime-inspector\/react-native"/g);
      expect(importStatements).toHaveLength(1);
      expect(importStatements![0].match(/__riObserveAnimation/g)).toHaveLength(1);
      expect(importStatements![0].match(/__riAnimationConfig/g)).toHaveLength(1);
    });

    it("accepts a string-literal duration key", () => {
      const normalized = transformAssignment(
        'card.moveX.value = withTiming(-110, { "duration": 260 });'
      );
      expect(normalized).toContain("__riAnimationConfig(");
      expect(normalized).toContain("declared: 260");
    });

    it("imports each helper once across several eligible call sites", () => {
      const normalized = transformAssignment(
        "card.moveX.value = withTiming(-110, { duration: 260 }); card.moveX.value = withTiming(0, { duration: 180 });"
      );
      expect(normalized.match(/__riAnimationConfig\(/g)).toHaveLength(2);
      expect(normalized.match(/__riAnimationConfig\b/g)).toHaveLength(3);
      expect(normalized.match(/__riObserveAnimation\b/g)).toHaveLength(3);
    });

    it("does not wrap a withSpring config", () => {
      const normalized = transformAssignment(
        "card.moveX.value = withSpring(0, { duration: 260, dampingRatio: 0.6 });"
      );
      expect(normalized).toContain(
        "__riObserveAnimation(__riAnimationStart(withSpring(0, { duration: 260, dampingRatio: 0.6 }), {"
      );
      expect(normalized).not.toContain("__riAnimationConfig");
      expect(normalized).not.toContain("parameterControls");
    });

    it.each([
      ["an identifier config", "withTiming(-110, timing)"],
      ["a non-literal duration", "withTiming(-110, { duration: d })"],
      ["a spread in the config object", "withTiming(-110, { ...base, duration: 260 })"],
      ["an out-of-range duration literal", "withTiming(-110, { duration: 20000 })"],
      ["no config argument", "withTiming(-110)"]
    ])("observes but does not wrap %s", (_label, call) => {
      const normalized = transformAssignment(`card.moveX.value = ${call};`);

      expect(normalized).toContain(
        `card.moveX.value = __riObserveAnimation(__riAnimationStart(${call}, {`
      );
      expect(normalized).not.toContain("__riAnimationConfig");
      expect(normalized).not.toContain("parameterControls");
    });

    it("leaves an eligible timing call untouched in production env", () => {
      const normalized = transformAssignment(
        "card.moveX.value = withTiming(-110, { duration: 260, easing });",
        "production"
      );

      expect(normalized).toContain("card.moveX.value = withTiming(-110, { duration: 260, easing });");
      expect(normalized).not.toContain("__riAnimationConfig");
      expect(normalized).not.toContain("__riObserveAnimation");
    });

    it("leaves an eligible timing call inside a known worklet context untouched", () => {
      const normalized = transformWithOpts(
        `
      import { useAnimatedStyle, withTiming } from "react-native-reanimated";
      function Card() {
        const opacity = { value: 0 };
        useAnimatedStyle(() => {
          opacity.value = withTiming(1, { duration: 180 });
          return { opacity: opacity.value };
        });
      }
    `,
        CARD_OPTS
      ).replace(/\s+/g, " ");

      expect(normalized).toContain("opacity.value = withTiming(1, { duration: 180 });");
      expect(normalized).not.toContain("__riAnimationConfig");
      expect(normalized).not.toContain("__riObserveAnimation");
      expect(normalized).not.toContain(SOURCE_IMPORT);
    });
  });

  describe("movable start and literal spring parameters (RFC 0005 3c)", () => {
    const CARD_OPTS = { filename: "/repo/src/Card.tsx", root: "/repo" };
    const RN_IMPORT = 'import { useInspector } from "@runtime-inspector/react-native";';
    const REANIMATED_IMPORT =
      'import { withDelay, withSpring, withTiming } from "react-native-reanimated";';

    function transformBody(
      body: string,
      options: { envName?: string; imports?: string } = {}
    ): string {
      return transformWithOpts(
        `
      ${RN_IMPORT}
      ${options.imports ?? REANIMATED_IMPORT}
      const stagger = 3;
      const timing = { duration: 260 };
      const spring = { damping: 14 };
      const extra = { mass: 2 };
      const card = useInspector("card-transition", { moveX: { value: 0, min: -120, max: 120 } });
      ${body}
    `,
        { ...CARD_OPTS, envName: options.envName ?? "development" }
      ).replace(/\s+/g, " ");
    }

    // The assignment under test is the first statement after the `card` declaration (line 9, col 6).
    const CALLSITE = "src/Card.tsx:9:6:";

    it("moves a delayed literal through a delay control", () => {
      const callsiteId = `${CALLSITE}timing:card.moveX`;
      const normalized = transformBody(
        "card.moveX.value = withDelay(120, withTiming(-110, { duration: 260 }));"
      );

      expect(normalized).toContain(
        "card.moveX.value = __riObserveAnimation(withDelay(__riAnimationDelay(120, { " +
          `callsiteId: "${callsiteId}", controlId: "${callsiteId}:delay", label: "card.moveX delay", ` +
          'declared: 120, min: 0, max: 10000, step: 1, unit: "ms", ' +
          literalProperty({ callee: "withTiming", parameter: "delay", init: "120" }) +
          " }), withTiming(-110, __riAnimationConfig({ duration: 260 }, ["
      );
      expect(normalized).toContain(
        `startControl: { schemaId: "auto", controlId: "${callsiteId}:delay" }`
      );
      expect(normalized).toContain(
        `parameterControls: { duration: { schemaId: "auto", controlId: "${callsiteId}:duration" } }`
      );
      expect(normalized).toContain(
        'expression: "withDelay(120, withTiming(-110, { duration: 260 }))"'
      );
      expect(normalized).not.toContain("__riAnimationStart");
      expect(normalized).not.toContain("__riWithDelay");

      const runtimeImport = normalized.match(
        /import \{[^}]*\} from "@runtime-inspector\/react-native"/g
      );
      expect(runtimeImport).toHaveLength(1);
      expect(runtimeImport![0]).toContain("__riAnimationDelay");
    });

    it("observes a delayed non-literal delay without a start control", () => {
      const callsiteId = `${CALLSITE}timing:card.moveX`;
      const normalized = transformBody(
        "card.moveX.value = withDelay(stagger * 2, withTiming(-110, { duration: 260 }));"
      );

      expect(normalized).toContain(
        `card.moveX.value = __riObserveAnimation(withDelay(__riAnimationDelay(stagger * 2, { callsiteId: "${callsiteId}" }), withTiming(`
      );
      expect(normalized).not.toContain("startControl");
      expect(normalized).not.toContain(":delay");
      expect(normalized).toContain("parameterControls");
    });

    it("does not bind an out-of-range literal delay", () => {
      const normalized = transformBody(
        "card.moveX.value = withDelay(20000, withTiming(-110, timing));"
      );

      expect(normalized).toContain("__riAnimationDelay(20000, { callsiteId:");
      expect(normalized).not.toContain("startControl");
    });

    it("leaves withDelay with three arguments untouched", () => {
      const normalized = transformBody(
        "card.moveX.value = withDelay(120, withTiming(-110, { duration: 260 }), 1);"
      );

      expect(normalized).toContain(
        "card.moveX.value = withDelay(120, withTiming(-110, { duration: 260 }), 1);"
      );
      expect(normalized).not.toContain("__riObserveAnimation");
    });

    it("leaves a withDelay-wrapped animation that has an explicit callback untouched", () => {
      const normalized = transformBody(
        "card.moveX.value = withDelay(120, withTiming(-110, { duration: 260 }, () => {}));"
      );

      expect(normalized).not.toContain("__riObserveAnimation");
    });

    it("leaves withDelay around a non-animation untouched", () => {
      const normalized = transformBody("card.moveX.value = withDelay(120, makeAnimation(-110));");

      expect(normalized).toContain("card.moveX.value = withDelay(120, makeAnimation(-110));");
      expect(normalized).not.toContain("__riObserveAnimation");
      expect(normalized).not.toContain("__riAnimationDelay");
    });

    it("wraps a bare call with the start helper and one separate withDelay import", () => {
      const callsiteId = `${CALLSITE}timing:card.moveX`;
      const normalized = transformBody("card.moveX.value = withTiming(-110, timing);");

      expect(normalized).toContain(
        "card.moveX.value = __riObserveAnimation(__riAnimationStart(withTiming(-110, timing), { " +
          `callsiteId: "${callsiteId}", controlId: "${callsiteId}:delay", label: "card.moveX delay", ` +
          'declared: 0, min: 0, max: 10000, step: 1, unit: "ms", ' +
          literalProperty({ callee: "withTiming", parameter: "delay", init: null }) +
          " }, __riWithDelay), {"
      );
      expect(normalized).toContain(
        `startControl: { schemaId: "auto", controlId: "${callsiteId}:delay" }`
      );
      expect(normalized).toContain(
        'import { withDelay as __riWithDelay } from "react-native-reanimated";'
      );
      // The user's own Reanimated import is left alone (the TS preset elides its unused names).
      expect(normalized).toContain('import { withTiming } from "react-native-reanimated";');
    });

    it("adds the withDelay import exactly once for several bare call sites", () => {
      const normalized = transformBody(
        "card.moveX.value = withTiming(-110, timing); card.moveX.value = withSpring(0, spring);"
      );

      expect(normalized.match(/withDelay as __riWithDelay/g)).toHaveLength(1);
      expect(normalized.match(/__riAnimationStart\(/g)).toHaveLength(2);
      const runtimeImport = normalized.match(
        /import \{[^}]*\} from "@runtime-inspector\/react-native"/g
      );
      expect(runtimeImport).toHaveLength(1);
      expect(runtimeImport![0].match(/__riAnimationStart/g)).toHaveLength(1);
    });

    it("adds the withDelay import once across a delayed and a bare call site", () => {
      const normalized = transformBody(
        "card.moveX.value = withDelay(120, withTiming(-110, timing)); card.moveX.value = withTiming(0, timing);"
      );

      expect(normalized.match(/withDelay as __riWithDelay/g)).toHaveLength(1);
      expect(normalized.match(/__riAnimationStart\(/g)).toHaveLength(1);
      expect(normalized.match(/__riAnimationDelay\(/g)).toHaveLength(1);
    });

    it("does not wrap the start of a bare call without a Reanimated import", () => {
      const normalized = transformBody("card.moveX.value = withTiming(-110, { duration: 260 });", {
        imports: 'import { withTiming } from "./my-animations";'
      });

      expect(normalized).toContain(
        "card.moveX.value = __riObserveAnimation(withTiming(-110, __riAnimationConfig("
      );
      expect(normalized).not.toContain("__riAnimationStart");
      expect(normalized).not.toContain("__riWithDelay");
      expect(normalized).not.toContain("startControl");
      expect(normalized).toContain("parameterControls");
    });

    it("does not count a type-only Reanimated import as a Reanimated import", () => {
      const normalized = transformBody("card.moveX.value = withTiming(-110, timing);", {
        imports:
          'import type { SharedValue } from "react-native-reanimated"; import { withTiming } from "./my-animations";'
      });

      expect(normalized).toContain("__riObserveAnimation(withTiming(-110, timing), {");
      expect(normalized).not.toContain("__riAnimationStart");
      expect(normalized).not.toContain("__riWithDelay");
    });

    it("binds all three spring literals", () => {
      const callsiteId = `${CALLSITE}spring:card.moveX`;
      const normalized = transformBody(
        "card.moveX.value = withSpring(0, { damping: 14, stiffness: 160, mass: 0.5 });"
      );

      expect(normalized).toContain(
        "__riAnimationConfig({ damping: 14, stiffness: 160, mass: 0.5 }, [" +
          `{ key: "damping", controlId: "${callsiteId}:damping", label: "card.moveX damping", declared: 14, min: 0, max: 100, step: 0.1, ` +
          literalProperty({ callee: "withSpring", parameter: "damping", init: "14" }) +
          " }, " +
          `{ key: "stiffness", controlId: "${callsiteId}:stiffness", label: "card.moveX stiffness", declared: 160, min: 1, max: 1000, step: 1, ` +
          literalProperty({ callee: "withSpring", parameter: "stiffness", init: "160" }) +
          " }, " +
          `{ key: "mass", controlId: "${callsiteId}:mass", label: "card.moveX mass", declared: 0.5, min: 0.1, max: 10, step: 0.1, ` +
          literalProperty({ callee: "withSpring", parameter: "mass", init: "0.5" }) +
          " }])"
      );
      expect(normalized).toContain(
        "parameterControls: { " +
          `damping: { schemaId: "auto", controlId: "${callsiteId}:damping" }, ` +
          `stiffness: { schemaId: "auto", controlId: "${callsiteId}:stiffness" }, ` +
          `mass: { schemaId: "auto", controlId: "${callsiteId}:mass" } }`
      );
      expect(normalized).toContain("config: { damping: 14, stiffness: 160, mass: 0.5 }");
    });

    it("binds only the spring keys that qualify", () => {
      const callsiteId = `${CALLSITE}spring:card.moveX`;
      const normalized = transformBody(
        "card.moveX.value = withSpring(0, { damping: 140, stiffness: 160, mass: extra.mass });"
      );

      expect(normalized).toContain(`key: "stiffness", controlId: "${callsiteId}:stiffness"`);
      expect(normalized).not.toContain('key: "damping"');
      expect(normalized).not.toContain('key: "mass"');
      expect(normalized).toContain(
        `parameterControls: { stiffness: { schemaId: "auto", controlId: "${callsiteId}:stiffness" } }`
      );
    });

    it.each([
      ["a spread in the config object", "{ ...spring, damping: 14, stiffness: 160 }"],
      ["a duplicated key", "{ damping: 14, damping: 20 }"],
      ["a computed string-literal duplicate", '{ damping: 14, ["damping"]: 20 }'],
      ["a method member", "{ damping() { return 14; } }"],
      ["a computed key", '{ ["damping"]: 14 }'],
      ["non-literal values", "{ damping: stagger, stiffness: 20 + 1 }"],
      ["out-of-range values", "{ damping: 101, stiffness: 0, mass: 0.05 }"]
    ])("binds no spring key for %s", (_label, config) => {
      const normalized = transformBody(`card.moveX.value = withSpring(0, ${config});`);

      expect(normalized).not.toContain("__riAnimationConfig(");
      expect(normalized).not.toContain("parameterControls");
      expect(normalized).toContain("__riObserveAnimation");
    });

    it("keeps an identifier spring config on the configControlId path", () => {
      const normalized = transformWithOpts(
        `
      import { useInspector } from "@runtime-inspector/react-native";
      import { withSpring } from "react-native-reanimated";
      function Card() {
        const card = useInspector("card-transition", {
          moveX: { value: 0, min: -120, max: 120 },
          spring: { damping: 14, stiffness: 180, mass: 1 }
        });
        const spring = card.spring.value;
        card.moveX.value = withSpring(card.$targets.moveX, spring);
        return card;
      }
    `,
        CARD_OPTS
      ).replace(/\s+/g, " ");

      expect(normalized).toContain('configControlId: "spring"');
      expect(normalized).not.toContain("__riAnimationConfig");
      expect(normalized).not.toContain("parameterControls");
      expect(normalized).toContain(
        "__riAnimationStart(withSpring(card.$targets.moveX, spring), {"
      );
    });

    it("keeps the timing duration binding identical inside a delayed call", () => {
      const callsiteId = `${CALLSITE}timing:card.moveX`;
      const normalized = transformBody(
        "card.moveX.value = withDelay(stagger, withTiming(-110, { duration: 260 }));"
      );

      expect(normalized).toContain(
        "withTiming(-110, __riAnimationConfig({ duration: 260 }, [{ " +
          `key: "duration", controlId: "${callsiteId}:duration", label: "card.moveX duration", ` +
          'declared: 260, min: 0, max: 10000, step: 1, unit: "ms", ' +
          literalProperty({ callee: "withTiming", parameter: "duration", init: "260" }) +
          " }]))"
      );
    });

    it("leaves delayed and bare animations untouched in production env", () => {
      const normalized = transformBody(
        "card.moveX.value = withDelay(120, withTiming(-110, { duration: 260 })); card.moveX.value = withSpring(0, { damping: 14 });",
        { envName: "production" }
      );

      expect(normalized).toContain(
        "card.moveX.value = withDelay(120, withTiming(-110, { duration: 260 })); card.moveX.value = withSpring(0, { damping: 14 });"
      );
      expect(normalized).not.toContain("__ri");
    });

    it("leaves delayed and bare animations inside a known worklet context untouched", () => {
      const normalized = transformWithOpts(
        `
      import { useAnimatedStyle, withDelay, withSpring, withTiming } from "react-native-reanimated";
      function Card() {
        const opacity = { value: 0 };
        useAnimatedStyle(() => {
          opacity.value = withDelay(120, withTiming(1, { duration: 180 }));
          opacity.value = withSpring(1, { damping: 14 });
          return { opacity: opacity.value };
        });
      }
    `,
        CARD_OPTS
      ).replace(/\s+/g, " ");

      expect(normalized).toContain(
        "opacity.value = withDelay(120, withTiming(1, { duration: 180 }));"
      );
      expect(normalized).toContain("opacity.value = withSpring(1, { damping: 14 });");
      expect(normalized).not.toContain("__ri");
    });
  });
});

const SOURCE_IMPORT = "@runtime-inspector/react-native";
describe("automatic motions and probes (RFC 0008)", () => {
  const OPTS = { filename: "/repo/src/Demo.tsx", root: "/repo" };
  const IMPORTS = `
      import { useCallback, useEffect, useLayoutEffect } from "react";
      import { useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
      import { useAction, useScene } from "@runtime-inspector/react-native";`;

  function motion(body: string, envName = "development"): string {
    return transformWithOpts(`${IMPORTS}\n${body}`, { ...OPTS, envName }).replace(/\s+/g, " ");
  }

  /** Callsite ids from the emitted `__riObserveAnimation` metas, in source order. */
  function observedCallsites(normalized: string): string[] {
    return Array.from(
      normalized.matchAll(/__riObserveAnimation\(.*?\{ callsiteId: "([^"]+)"/g),
      (match) => match[1]
    );
  }

  function motionCalls(normalized: string): string[] {
    return Array.from(normalized.matchAll(/__riMotion\("([^"]+)"/g), (match) => match[1]);
  }

  /** The `callsites` array literal of the `__riMotion` meta for `sceneId`. */
  function motionCallsites(normalized: string, sceneId: string): string[] {
    const start = normalized.indexOf(`__riMotion("${sceneId}"`);
    expect(start).toBeGreaterThanOrEqual(0);
    const match = /callsites: \[([^\]]*)\]/.exec(normalized.slice(start));
    return Array.from((match?.[1] ?? "").matchAll(/"([^"]+)"/g), (item) => item[1]);
  }

  it("injects a function declaration once, after it, with every callsite id of its animations", () => {
    const normalized = motion(`
      export function ProductRevealDemo() {
        const coverOpacity = useSharedValue(0);
        const titleY = useSharedValue(24);
        function play() {
          coverOpacity.value = 0;
          coverOpacity.value = withTiming(1, { duration: 320 });
          titleY.value = withDelay(140, withTiming(0, { duration: 380 }));
        }
        return play;
      }
    `);

    expect(normalized).toContain(
      'function play() { coverOpacity.value = 0; coverOpacity.value = __riObserveAnimation('
    );
    expect(motionCalls(normalized)).toEqual(["src/Demo.tsx:ProductRevealDemo.play"]);
    expect(normalized).toMatch(
      /\} __riMotion\("src\/Demo\.tsx:ProductRevealDemo\.play", play, \{ component: "ProductRevealDemo", name: "play", file: "src\/Demo\.tsx", line: 9, callsites: \[/
    );
    const callsites = motionCallsites(normalized, "src/Demo.tsx:ProductRevealDemo.play");
    expect(callsites).toEqual([
      "src/Demo.tsx:11:10:timing:coverOpacity",
      "src/Demo.tsx:12:10:timing:titleY"
    ]);
    expect(callsites).toEqual(observedCallsites(normalized));
    const runtimeImports = normalized.match(/import \{[^}]*\} from "@runtime-inspector\/react-native"/g);
    expect(runtimeImports).toHaveLength(1);
    expect(runtimeImports![0].match(/__riMotion/g)).toHaveLength(1);
    expect(runtimeImports![0].match(/__riProbe/g)).toHaveLength(1);
  });

  it.each([
    ["an arrow", "const play = () => { opacity.value = withTiming(1, { duration: 200 }); };", "const play = __riMotion("],
    ["a function expression", "const play = function () { opacity.value = withTiming(1, { duration: 200 }); };", "const play = __riMotion("],
    ["useCallback", "const play = useCallback(() => { opacity.value = withTiming(1, { duration: 200 }); }, []);", "const play = __riMotion(\"src/Demo.tsx:Card.play\", useCallback(() =>"]
  ])("wraps the initializer of %s", (_label, declaration, expected) => {
    const normalized = motion(`
      function Card() {
        const opacity = useSharedValue(0);
        ${declaration}
        return play;
      }
    `);

    expect(normalized).toContain(expected);
    expect(motionCalls(normalized)).toEqual(["src/Demo.tsx:Card.play"]);
    expect(normalized).toContain('{ component: "Card", name: "play", file: "src/Demo.tsx", line: 8, callsites: [');
    expect(motionCallsites(normalized, "src/Demo.tsx:Card.play")).toEqual(observedCallsites(normalized));
  });

  it("keeps the enclosure of an animation in a wrapped const arrow", () => {
    const normalized = motion(`
      function Card() {
        const opacity = useSharedValue(0);
        const play = () => { opacity.value = withTiming(1, { duration: 200 }); };
        return play;
      }
    `);

    expect(normalized).toContain('enclosure: ["Card", "play"]');
  });

  it("finds components declared as const arrows and default exports", () => {
    const normalized = motion(`
      export const Sheet = () => {
        const y = useSharedValue(400);
        function open() { y.value = withSpring(0, { damping: 18 }); }
        return open;
      };
      export default function Welcome() {
        const logo = useSharedValue(0);
        function intro() { logo.value = withTiming(1, { duration: 260 }); }
        return intro;
      }
    `);

    expect(motionCalls(normalized)).toEqual([
      "src/Demo.tsx:Sheet.open",
      "src/Demo.tsx:Welcome.intro"
    ]);
  });

  it("wraps a pure-motion effect and names it by its line", () => {
    const normalized = motion(`
      function Card() {
        const opacity = useSharedValue(0);
        function play() { opacity.value = withTiming(1, { duration: 200 }); }
        useEffect(() => {
          opacity.value = 0;
          opacity.value = withSpring(1, { damping: 12 });
          play();
        }, []);
        return null;
      }
    `);

    expect(normalized).toContain('useEffect(__riMotion("src/Demo.tsx:Card.effect@9", () => {');
    expect(normalized).toContain(
      '{ component: "Card", name: "effect", file: "src/Demo.tsx", line: 9, callsites: ["src/Demo.tsx:11:10:spring:opacity"] }), []);'
    );
    expect(motionCalls(normalized)).toEqual([
      "src/Demo.tsx:Card.play",
      "src/Demo.tsx:Card.effect@9"
    ]);
  });

  it("wraps a pure useLayoutEffect", () => {
    const normalized = motion(`
      function Card() {
        const opacity = useSharedValue(0);
        useLayoutEffect(() => { opacity.value = withTiming(1, { duration: 200 }); }, []);
        return null;
      }
    `);

    expect(normalized).toContain('useLayoutEffect(__riMotion("src/Demo.tsx:Card.effect@8", () =>');
  });

  it.each([
    ["a subscription", "const id = setInterval(() => {}, 100);"],
    ["a timer", "setTimeout(() => {}, 100);"],
    ["a state update", "setOpen(true);"],
    ["a cleanup", "return () => {};"]
  ])("does not wrap an effect with %s, but still observes its animations", (_label, statement) => {
    const normalized = motion(`
      function Card({ setOpen }) {
        const opacity = useSharedValue(0);
        useEffect(() => {
          opacity.value = withTiming(1, { duration: 200 });
          ${statement}
        }, []);
        return null;
      }
    `);

    expect(normalized).not.toContain("__riMotion");
    expect(normalized).toContain("__riObserveAnimation(");
  });

  it("does not make an effect without its own animations a motion", () => {
    const normalized = motion(`
      function Card() {
        const opacity = useSharedValue(0);
        function play() { opacity.value = withTiming(1, { duration: 200 }); }
        useEffect(() => { play(); }, []);
        return null;
      }
    `);

    expect(motionCalls(normalized)).toEqual(["src/Demo.tsx:Card.play"]);
    expect(normalized).toContain("useEffect(() => { play(); }, []);");
  });

  it("attributes an animation in a setTimeout callback to the nearest motion function", () => {
    const normalized = motion(`
      function CardTransitionLab() {
        const moveX = useSharedValue(0);
        function replayTransition() {
          moveX.value = withTiming(-110, { duration: 260 });
          setTimeout(() => {
            moveX.value = withSpring(0, { damping: 14 });
          }, 220);
        }
        return replayTransition;
      }
    `);

    expect(motionCalls(normalized)).toEqual(["src/Demo.tsx:CardTransitionLab.replayTransition"]);
    expect(
      motionCallsites(normalized, "src/Demo.tsx:CardTransitionLab.replayTransition")
    ).toEqual(["src/Demo.tsx:9:10:timing:moveX", "src/Demo.tsx:11:12:spring:moveX"]);
  });

  it("leaves inline handlers, render-time assignments and nested components alone", () => {
    const normalized = motion(`
      function Card() {
        const opacity = useSharedValue(0);
        opacity.value = withTiming(1, { duration: 100 });
        function Inner() {
          function bump() { opacity.value = withTiming(0.5, { duration: 100 }); }
          return bump;
        }
        return <Pressable onPress={() => { opacity.value = withTiming(0, { duration: 100 }); }} />;
      }
    `);

    expect(normalized).not.toContain("__riMotion");
    expect(normalized.match(/__riObserveAnimation\(/g)).toHaveLength(3);
  });

  it("does not inject inside conditionals, loops or nested functions", () => {
    const normalized = motion(`
      function Card({ on }) {
        const opacity = useSharedValue(0);
        if (on) {
          function a() { opacity.value = withTiming(1, { duration: 100 }); }
          a();
        }
        for (const x of [1]) {
          const b = () => { opacity.value = withTiming(x, { duration: 100 }); };
          b();
        }
        return null;
      }
    `);

    expect(normalized).not.toContain("__riMotion");
  });

  it("does not inject after an early return, so the hook stays unconditional", () => {
    const normalized = motion(`
      function Card({ hidden }) {
        const opacity = useSharedValue(0);
        if (hidden) return null;
        const play = () => { opacity.value = withTiming(1, { duration: 100 }); };
        return play;
      }
    `);

    expect(normalized).not.toContain("__riMotion");
  });

  it.each([
    ["passed to useScene", "useScene(\"reveal\", play);"],
    ["passed to useAction", "useAction(\"replay\", play);"]
  ])("skips an explicit function %s", (_label, call) => {
    const normalized = motion(`
      function Card() {
        const opacity = useSharedValue(0);
        function play() { opacity.value = withTiming(1, { duration: 100 }); }
        ${call}
        return null;
      }
    `);

    expect(normalized).not.toContain("__riMotion");
    expect(normalized).toContain("__riObserveAnimation(");
  });

  it("skips a function initialized by useScene", () => {
    const normalized = motion(`
      function Card() {
        const opacity = useSharedValue(0);
        const play = useScene("reveal", () => { opacity.value = withTiming(1, { duration: 100 }); });
        return play;
      }
    `);

    expect(normalized).not.toContain("__riMotion");
    expect(normalized).toContain("__riObserveAnimation(");
  });

  it("reads the title and group of a // @scene comment", () => {
    const normalized = motion(`
      function ProductRevealDemo() {
        const opacity = useSharedValue(0);
        // @scene "Product reveal" group="Store"
        function play() { opacity.value = withTiming(1, { duration: 100 }); }
        /* @scene "Fade" */
        const fade = () => { opacity.value = withTiming(0, { duration: 100 }); };
        // @scene group="Lab"
        useEffect(() => { opacity.value = withTiming(1, { duration: 100 }); }, []);
        return null;
      }
    `);

    expect(normalized).toContain(
      'name: "play", file: "src/Demo.tsx", line: 9, title: "Product reveal", group: "Store", callsites: ['
    );
    expect(normalized).toContain('name: "fade", file: "src/Demo.tsx", line: 11, title: "Fade", callsites: [');
    expect(normalized).toContain('name: "effect", file: "src/Demo.tsx", line: 13, group: "Lab", callsites: [');
  });

  it("excludes a function marked // @scene off", () => {
    const normalized = motion(`
      function Card() {
        const opacity = useSharedValue(0);
        // @scene off
        function play() { opacity.value = withTiming(1, { duration: 100 }); }
        return play;
      }
    `);

    expect(normalized).not.toContain("__riMotion");
    expect(normalized).toContain("__riObserveAnimation(");
  });

  it.each([
    ["an unquoted title", "// @scene Product reveal"],
    ["an unknown key", '// @scene "Reveal" color="red"'],
    ["the group before the title", '// @scene group="Store" "Reveal"'],
    ["an empty title", '// @scene ""'],
    ["an unquoted group", '// @scene "Reveal" group=Store']
  ])("fails the build for %s", (_label, comment) => {
    expect(() =>
      motion(`
      function Card() {
        const opacity = useSharedValue(0);
        ${comment}
        function play() { opacity.value = withTiming(1, { duration: 100 }); }
        return play;
      }
    `)
    ).toThrow(/invalid \/\/ @scene comment.*@scene "Title" group="Group"/s);
  });

  it("ignores comments that only start with @scene as part of another word", () => {
    const normalized = motion(`
      function Card() {
        const opacity = useSharedValue(0);
        // @scenery is not a directive
        function play() { opacity.value = withTiming(1, { duration: 100 }); }
        return play;
      }
    `);

    expect(motionCalls(normalized)).toEqual(["src/Demo.tsx:Card.play"]);
  });

  it("wraps only animated top-level literal shared values in __riProbe", () => {
    const normalized = motion(`
      function ProductRevealDemo() {
        const titleY = useSharedValue(24);
        const rowX = useSharedValue(-40);
        const visible = useSharedValue(false);
        const idle = useSharedValue(0);
        const config = useSharedValue({ x: 1 });
        const nested = useSharedValue(0);
        const box = { inner: useSharedValue(0) };
        function play() {
          titleY.value = withTiming(0, { duration: 380 });
          rowX.value = withTiming(0, { duration: 360 });
          visible.value = withTiming(true, { duration: 1 });
          config.value = withTiming({ x: 2 });
          box.inner.value = withTiming(1, { duration: 1 });
          idle.value = 1;
        }
        function Inner() {
          const deep = useSharedValue(0);
          deep.value = withTiming(1, { duration: 1 });
          return deep;
        }
        return play;
      }
    `);

    expect(normalized).toContain(
      'const titleY = __riProbe(useSharedValue(24), "titleY", { component: "ProductRevealDemo", file: "src/Demo.tsx" });'
    );
    expect(normalized).toContain('const rowX = __riProbe(useSharedValue(-40), "rowX", {');
    expect(normalized).toContain('const visible = __riProbe(useSharedValue(false), "visible", {');
    expect(normalized).toContain("const idle = useSharedValue(0);");
    expect(normalized).toContain("const config = useSharedValue({ x: 1 });");
    expect(normalized).toContain("const nested = useSharedValue(0);");
    expect(normalized).toContain("inner: useSharedValue(0)");
    expect(normalized).toContain("const deep = useSharedValue(0);");
    expect(normalized.match(/__riProbe\(/g)).toHaveLength(3);
  });

  it("does not probe a shared value only animated inside a worklet context", () => {
    const normalized = motion(`
      function Card() {
        const opacity = useSharedValue(0);
        useAnimatedStyle(() => {
          opacity.value = withTiming(1, { duration: 1 });
          return {};
        });
        return null;
      }
    `);

    expect(normalized).not.toContain("__riProbe");
    expect(normalized).not.toContain("__riMotion");
  });

  it("composes the probe with // @inspect", () => {
    const normalized = motion(`
      function Card() {
        // @inspect min=0 max=1
        const opacity = useSharedValue(0);
        function play() { opacity.value = withTiming(1, { duration: 100 }); }
        return play;
      }
    `);

    expect(normalized).toContain(
      'const opacity = __riProbe(__riInspect(useSharedValue(0), "opacity", { min: 0, max: 1, label: "opacity", source: { file: "src/Demo.tsx", line: 8, column: 14, enclosure: ["Card"], name: "opacity", init: "0" } }), "opacity", { component: "Card", file: "src/Demo.tsx" });'
    );
    expect(normalized).toContain('schemaId: "auto"');
  });

  it("leaves motions and probes untouched in production", () => {
    const normalized = motion(
      `
      function Card() {
        const opacity = useSharedValue(0);
        // @scene "Fade" group="Lab"
        function play() { opacity.value = withTiming(1, { duration: 100 }); }
        useEffect(() => { opacity.value = withTiming(1, { duration: 100 }); }, []);
        return play;
      }
    `,
      "production"
    );

    expect(normalized).not.toContain("__ri");
    expect(normalized).toContain("const opacity = useSharedValue(0);");
  });

  it("does not run without a filename", () => {
    const code = transformWithOpts(
      `${IMPORTS}
      function Card() {
        const opacity = useSharedValue(0);
        function play() { opacity.value = withTiming(1, { duration: 100 }); }
        return play;
      }`,
      { filename: undefined }
    );

    expect(code).not.toContain("__riMotion");
    expect(code).not.toContain("__riProbe");
  });

  const reanimatedPlugin = (() => {
    try {
      return require.resolve("react-native-reanimated/plugin", {
        paths: [resolvePath(__dirname, "../../../examples/react-native-reanimated")]
      });
    } catch {
      return undefined;
    }
  })();

  it.skipIf(!reanimatedPlugin)("keeps the output valid for the Reanimated plugin", () => {
    const source = `${IMPORTS}
      import { useAnimatedStyle } from "react-native-reanimated";
      export function Demo() {
        const opacity = useSharedValue(0);
        // @scene "Fade" group="Lab"
        function play() {
          opacity.value = withTiming(1, { duration: 100 });
          setTimeout(() => { opacity.value = withSpring(0, { damping: 10 }); }, 50);
        }
        const replay = useCallback(() => { opacity.value = withTiming(0, { duration: 100 }); }, []);
        useEffect(() => { opacity.value = withTiming(1, { duration: 100 }); }, []);
        const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
        return [play, replay, style];
      }`;
    // The Reanimated plugin reads the file from disk.
    const root = mkdtempSync(joinPath(tmpdir(), "ri-motion-"));
    mkdirSync(joinPath(root, "src"));
    const filename = joinPath(root, "src", "Demo.tsx");
    writeFileSync(filename, source);
    const result = transformSync(source, {
      filename,
      root,
      presets: [["@babel/preset-typescript", { isTSX: true, allExtensions: true }]],
      plugins: [plugin, reanimatedPlugin!],
      envName: "development",
      babelrc: false,
      configFile: false
    });
    const code = result?.code ?? "";

    expect(code).toContain('__riMotion("src/Demo.tsx:Demo.play", play,');
    expect(code).toContain('__riMotion("src/Demo.tsx:Demo.replay", useCallback(');
    expect(code).toContain('useEffect(__riMotion("src/Demo.tsx:Demo.effect@14",');
    expect(code).toContain("__riProbe(useSharedValue(0)");
    // Reanimated still workletizes the style callback, and the output parses.
    expect(code).toContain("__workletHash");
    expect(() => parseSync(code, { babelrc: false, configFile: false, filename: "out.js" })).not.toThrow();
  });
});

describe("animation literal anchors (RFC 0007)", () => {
  const OPTS = { filename: "/repo/src/Demo.tsx", root: "/repo" };
  const IMPORTS = `
      import * as Reanimated from "react-native-reanimated";
      import { useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";`;

  function build(body: string): string {
    return transformWithOpts(`${IMPORTS}\n${body}`, OPTS).replace(/\s+/g, " ");
  }

  it("anchors every literal of a function-declaration motion to its enclosure", () => {
    const normalized = build(`
      export function ProductRevealDemo() {
        const titleY = useSharedValue(24);
        function play() {
          titleY.value = withDelay(140, withTiming(0, { duration: 380 }));
        }
        return play;
      }
    `);

    const base = {
      file: "src/Demo.tsx",
      line: 8,
      column: 10,
      enclosure: ["ProductRevealDemo", "play"],
      target: "titleY.value",
      callee: "withTiming"
    };
    expect(normalized).toContain(literalProperty({ ...base, parameter: "delay", init: "140" }));
    expect(normalized).toContain(literalProperty({ ...base, parameter: "duration", init: "380" }));
    expect(normalized).toContain(
      'source: { file: "src/Demo.tsx", line: 8, column: 10, enclosure: ["ProductRevealDemo", "play"]'
    );
  });

  it("anchors a bare call in a wrapped const arrow with init null for its delay", () => {
    const normalized = build(`
      function Card() {
        const opacity = useSharedValue(0);
        const play = () => { opacity.value = withSpring(1, { damping: 12 }); };
        return play;
      }
    `);

    expect(normalized).toContain("const play = __riMotion(");
    const base = {
      file: "src/Demo.tsx",
      line: 7,
      column: 29,
      enclosure: ["Card", "play"],
      target: "opacity.value",
      callee: "withSpring"
    };
    expect(normalized).toContain(literalProperty({ ...base, parameter: "damping", init: "12" }));
    expect(normalized).toContain(literalProperty({ ...base, parameter: "delay", init: null }));
  });

  it("keeps the literal text as written and the callee name of a member call", () => {
    const normalized = build(`
      function Card() {
        const opacity = useSharedValue(0);
        function play() {
          opacity.value = Reanimated.withDelay(1.50e2, Reanimated.withTiming(1, { "duration": 0x10 }));
        }
        return play;
      }
    `);

    const base = {
      file: "src/Demo.tsx",
      line: 8,
      column: 10,
      enclosure: ["Card", "play"],
      target: "opacity.value",
      callee: "withTiming"
    };
    expect(normalized).toContain(literalProperty({ ...base, parameter: "delay", init: "1.50e2" }));
    expect(normalized).toContain(literalProperty({ ...base, parameter: "duration", init: "0x10" }));
  });

  it("emits no literal for a delay that has no control", () => {
    const normalized = build(`
      function Card({ stagger }) {
        const opacity = useSharedValue(0);
        function play() { opacity.value = withDelay(stagger, withTiming(1, { duration: 200 })); }
        return play;
      }
    `);

    expect(normalized).not.toContain('parameter: "delay"');
    expect(normalized).toContain('parameter: "duration", init: "200"');
  });
});
