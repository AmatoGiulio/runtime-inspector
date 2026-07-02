import { transformSync } from "@babel/core";
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
      '__riInspect(useSharedValue(0), "moveX", { min: -120, max: 120, step: 1, unit: "px", label: "Move X" })'
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
});

const SOURCE_IMPORT = "@runtime-inspector/react-native";
