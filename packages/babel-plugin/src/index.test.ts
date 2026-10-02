import { transformSync, type TransformOptions } from "@babel/core";
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
    expect(normalized).toContain("__riObserveAnimation(withTiming(-110, { duration: 260 })");
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
    expect(normalized).toContain("__riObserveAnimation(withSpring(0, { damping: 14, stiffness: 180 })");
    expect(normalized).toContain('schemaId: "card-transition"');
    expect(normalized).toContain('target: "card.moveX"');
    expect(normalized).toContain('animationKind: "spring"');
    expect(normalized).toContain('configControlId: "spring"');
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
    expect(normalized).toContain("__riObserveAnimation(withSpring(card.$targets.moveX, spring)");
    expect(normalized).toContain('configControlId: "spring"');
    expect(normalized.match(/withSpring\(card\.\$targets\.moveX, spring\)/g)).toHaveLength(1);
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
});

const SOURCE_IMPORT = "@runtime-inspector/react-native";