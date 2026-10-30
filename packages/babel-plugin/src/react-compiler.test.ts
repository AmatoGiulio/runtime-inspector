import { transformSync } from "@babel/core";
import reactCompiler from "babel-plugin-react-compiler";
import { describe, expect, it } from "vitest";
import plugin from "./index";

interface CompilerEvent {
  kind: string;
  detail?: { reason?: string; options?: { reason?: string } };
}

// babel-preset-expo runs the React Compiler after the app's own plugins, so this is the
// order an Expo app gets: Runtime Inspector first, the compiler later in the same pass.
function compile(code: string, withRuntimeInspector = true): { output: string; events: string[] } {
  const events: string[] = [];
  const logger = {
    logEvent(_filename: string | null, event: CompilerEvent) {
      const reason = event.detail?.reason ?? event.detail?.options?.reason;
      events.push(reason ? `${event.kind}: ${reason}` : event.kind);
    }
  };
  const result = transformSync(code, {
    filename: "/root/src/Demo.tsx",
    root: "/root",
    cwd: "/root",
    presets: [["@babel/preset-typescript", { isTSX: true, allExtensions: true }]],
    plugins: [...(withRuntimeInspector ? [plugin] : []), [reactCompiler, { logger }]],
    envName: "development",
    babelrc: false,
    configFile: false
  });
  if (!result?.code) throw new Error("transform produced no output");
  return { output: result.code, events };
}

/** The compiler's memoization branches: the body of every `if ($[n] ...) { ... }`. */
function memoizationBranches(output: string): string[] {
  const branches: string[] = [];
  let start = output.search(/if \(\$\[\d+\]/);
  while (start !== -1) {
    const open = output.indexOf("{", start);
    let depth = 0;
    let end = open;
    for (; end < output.length; end++) {
      if (output[end] === "{") depth++;
      if (output[end] === "}" && --depth === 0) break;
    }
    branches.push(output.slice(open + 1, end));
    const next = output.slice(end).search(/if \(\$\[\d+\]/);
    start = next === -1 ? -1 : end + next;
  }
  return branches;
}

const ANIMATED_CARD = `
  import { useSharedValue, withTiming } from "react-native-reanimated";
  export function Card({ size }) {
    // @inspect min=0 max=1
    const opacity = useSharedValue(0);
    const show = () => {
      opacity.value = withTiming(size, { duration: 200 });
    };
    return <View onPress={show} />;
  }
`;

describe("with the React Compiler", () => {
  it("compiles the fixture without Runtime Inspector (baseline)", () => {
    const { output, events } = compile(ANIMATED_CARD, false);
    expect(events).toEqual(["CompileSuccess"]);
    expect(output).toContain("react/compiler-runtime");
  });

  it("still compiles it with Runtime Inspector", () => {
    const { output, events } = compile(ANIMATED_CARD);
    expect(events).toEqual(["CompileSuccess"]);
    expect(output).toContain("react/compiler-runtime");
  });

  it("keeps the // @inspect directive", () => {
    const { output } = compile(ANIMATED_CARD);
    expect(output).toContain('__riInspect(opacity, "opacity"');
  });

  it("discovers a `.value =` animation in a component callback", () => {
    const { output } = compile(ANIMATED_CARD);
    expect(output).toContain("__riObserveAnimation(");
    expect(output).toContain('callsiteId: "src/Demo.tsx:7:6:timing:opacity"');
  });

  it("calls the scene and probe hooks with static arguments, outside every memoization branch", () => {
    const { output } = compile(ANIMATED_CARD);
    // The compiler may hoist the static meta objects into its cache; the calls stay put.
    expect(output).toMatch(/const _riScene = useRiScene\("src\/Demo\.tsx:Card\.show", /);
    expect(output).toContain("__riMotionFn(_riScene, () =>");
    expect(output).toMatch(/const _riProbe = useRiProbe\("opacity", /);
    expect(output).toContain("__riProbeValue(_riProbe, opacity)");

    const branches = memoizationBranches(output);
    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) {
      expect(branch).not.toMatch(/useRi(Scene|Probe)\(/);
    }
  });

  // The compiler must reach the same outcome with Runtime Inspector as without it: compile
  // the component, or skip it for the same reason. Each shape is a way a motion function or
  // an animated shared value appears in app code.
  it.each([
    [
      "a function declaration",
      `function show() { opacity.value = withTiming(size, { duration: 200 }); }
       return <View onPress={show} />;`
    ],
    [
      "a const arrow",
      `const show = () => { opacity.value = withTiming(size, { duration: 200 }); };
       return <View onPress={show} />;`
    ],
    [
      "useCallback",
      `const show = useCallback(() => { opacity.value = withTiming(size, { duration: 200 }); }, [size]);
       return <View onPress={show} />;`
    ],
    [
      "a pure-motion effect",
      `useEffect(() => { opacity.value = withTiming(size, { duration: 200 }); }, [size]);
       return <View />;`
    ],
    [
      "an inspected value animated with .set (not discovered)",
      `const show = () => { opacity.set(withTiming(size)); };
       return <View onPress={show} />;`
    ]
  ])("reports the same compiler outcome for %s as without Runtime Inspector", (_label, body) => {
    const code = `
      import { useCallback, useEffect } from "react";
      import { useSharedValue, withTiming } from "react-native-reanimated";
      export function Card({ size }) {
        // @inspect min=0 max=1
        const opacity = useSharedValue(0);
        ${body}
      }
    `;
    const baseline = compile(code, false);
    const instrumented = compile(code);
    expect(instrumented.events).toEqual(baseline.events);
    expect(instrumented.output.includes("react/compiler-runtime")).toBe(
      baseline.output.includes("react/compiler-runtime")
    );
  });
});
