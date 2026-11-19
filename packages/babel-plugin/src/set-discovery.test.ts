import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";
import plugin from "./index";

// Issue #8: Reanimated 4 recommends `x.set(...)` over `x.value = ...` for React Compiler
// compatibility. The `.set` form is discovered with the same rules as the assignment, and
// only where the write runs on the JS thread.

const IMPORTS = `
  import { useCallback, useEffect } from "react";
  import { Gesture, usePanGesture } from "react-native-gesture-handler";
  import {
    runOnUI, useAnimatedStyle, useDerivedValue, useSharedValue, withDelay, withSpring, withTiming
  } from "react-native-reanimated";
  import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";`;

function transform(code: string, filename = "/repo/src/Card.tsx"): string {
  const result = transformSync(code, {
    filename,
    root: "/repo",
    presets: [["@babel/preset-typescript", { isTSX: true, allExtensions: true }]],
    plugins: [plugin],
    envName: "development",
    babelrc: false,
    configFile: false
  });
  if (!result?.code) throw new Error("transform produced no output");
  return result.code.replace(/\s+/g, " ");
}

/** A component whose body is `body`, with the shared values the cases use. */
function card(body: string, prelude = ""): string {
  return `${IMPORTS}
${prelude}
export function Card() {
  const logo = useSharedValue(0);
  const title = { y: useSharedValue(0) };
  ${body}
  return null;
}`;
}

function callsiteIds(normalized: string): string[] {
  return Array.from(
    normalized.matchAll(/__riObserveAnimation\(.*?\{ callsiteId: "([^"]+)"/g),
    (match) => match[1]
  );
}

describe("discovery of `.set(...)` writes (issue #8)", () => {
  it("instruments a `.set(withSpring(...))` in an event handler, like the assignment form", () => {
    const normalized = transform(
      card(`const show = () => {
    logo.set(withSpring(1, { damping: 14, stiffness: 160 }));
  };`)
    );

    expect(callsiteIds(normalized)).toEqual(["src/Card.tsx:13:4:spring:logo"]);
    expect(normalized).toContain("logo.set(__riObserveAnimation(");
    expect(normalized).toContain(
      'withSpring(1, __riAnimationConfig({ damping: 14, stiffness: 160 }, [{ key: "damping"'
    );
    // RFC 0007 amendment: the literal anchor's target is the `.set` callee.
    expect(normalized).toContain(
      'literal: { file: "src/Card.tsx", line: 13, column: 4, enclosure: ["Card", "show"], target: "logo.set", callee: "withSpring", parameter: "damping", init: "14" }'
    );
    expect(normalized).toContain('label: "logo damping"');
    expect(normalized).toContain('source: { file: "src/Card.tsx", line: 13, column: 4, enclosure: ["Card", "show"], expression: "withSpring(1, { damping: 14, stiffness: 160 })" }');
  });

  it("instruments a delayed write and a nested target", () => {
    const normalized = transform(
      card(`useEffect(() => {
    title.y.set(withDelay(120, withTiming(0, { duration: 380 })));
  }, []);`)
    );

    expect(callsiteIds(normalized)).toEqual(["src/Card.tsx:13:4:timing:title.y"]);
    expect(normalized).toContain("__riAnimationDelay(120,");
    expect(normalized).toContain('target: "title.y.set", callee: "withTiming", parameter: "delay", init: "120"');
  });

  it.each([
    ["a JSX event handler", `const view = <View onPress={() => logo.set(withTiming(1, { duration: 200 }))} />;`],
    ["useCallback", `const show = useCallback(() => { logo.set(withTiming(1, { duration: 200 })); }, []);`],
    ["a function declaration", `function show() { logo.set(withTiming(1, { duration: 200 })); }`],
    ["a callback scheduled back on the JS thread", `const go = () => scheduleOnRN(() => { logo.set(withTiming(1, { duration: 200 })); });`],
    ["a setTimeout callback", `useEffect(() => { setTimeout(() => logo.set(withTiming(1, { duration: 200 })), 10); }, []);`]
  ])("instruments it in %s", (_label, body) => {
    expect(callsiteIds(transform(card(body)))).toHaveLength(1);
  });

  it.each([
    ["useAnimatedStyle", `useAnimatedStyle(() => { logo.set(withTiming(1, { duration: 200 })); return {}; });`],
    ["useDerivedValue", `useDerivedValue(() => { logo.set(withTiming(1, { duration: 200 })); });`],
    ["scheduleOnUI", `const go = () => scheduleOnUI(() => { logo.set(withTiming(1, { duration: 200 })); });`],
    ["runOnUI", `const go = () => runOnUI(() => { logo.set(withTiming(1, { duration: 200 })); })();`],
    ["a function passed to scheduleOnUI by reference", `const animate = () => { logo.set(withTiming(1, { duration: 200 })); };
     const go = () => scheduleOnUI(animate);`],
    ["a function assigned to a `let` passed to useAnimatedStyle", `let style; style = () => { logo.set(withTiming(1, { duration: 200 })); return {}; };
     useAnimatedStyle(style);`],
    ["an alias of a function passed to useAnimatedStyle", `const style = () => { logo.set(withTiming(1, { duration: 200 })); return {}; };
     const alias = style;
     useAnimatedStyle(alias);`],
    ["a Gesture Handler builder callback", `const pan = Gesture.Pan().onEnd(() => { logo.set(withSpring(0, { damping: 10 })); });`],
    ["a builder callback on a stored gesture", `const tap = Gesture.Tap(); tap.onEnd(() => { logo.set(withSpring(0, { damping: 10 })); });`],
    ["a Gesture Handler 3 hook callback", `const pan = usePanGesture({ onDeactivate: () => { logo.set(withSpring(0, { damping: 10 })); } });`],
    ["a Gesture Handler 3 hook method", `const pan = usePanGesture({ onDeactivate() { logo.set(withSpring(0, { damping: 10 })); } });`],
    ["a Gesture Handler 3 config passed by reference", `const config = { onDeactivate: () => { logo.set(withSpring(0, { damping: 10 })); } };
     const pan = usePanGesture(config);`],
    ["an animation callback", `const go = () => { logo.set(withTiming(1, { duration: 200 }, () => { title.y.set(withTiming(0, { duration: 100 })); })); };`],
    ["a 'worklet' function", `const go = () => { 'worklet'; logo.set(withTiming(1, { duration: 200 })); };`],
    ["a function nested in a worklet", `useAnimatedStyle(() => { const inner = () => logo.set(withTiming(1, { duration: 200 })); inner(); return {}; });`]
  ])("leaves it untouched inside %s (UI thread)", (_label, body) => {
    const normalized = transform(card(body));
    expect(normalized).not.toContain("logo.set(__riObserveAnimation(");
    expect(callsiteIds(normalized).filter((id) => id.endsWith(":logo"))).toEqual([]);
    expect(normalized).not.toContain("__riAnimationConfig");
  });

  it("applies the same thread rules to `.value =` (a write scheduled on the UI thread is left alone)", () => {
    const normalized = transform(
      card(`const go = () => scheduleOnUI(() => { logo.value = withTiming(1, { duration: 200 }); });`)
    );
    expect(normalized).toContain("logo.value = withTiming(1, { duration: 200 });");
    expect(callsiteIds(normalized)).toEqual([]);
  });

  it("leaves a whole 'worklet' file alone", () => {
    const normalized = transform(`'worklet';\n${card("const go = () => logo.set(withTiming(1, { duration: 200 }));")}`);
    expect(callsiteIds(normalized)).toEqual([]);
  });

  it.each([
    ["a Map write", `const map = new Map(); map.set("a", withTiming(1));`],
    ["a plain value", `const go = () => logo.set(1);`],
    ["an updater function", `const go = () => logo.set((v) => withTiming(v + 1));`],
    ["a computed member", `const go = () => logo["set"](withTiming(1, { duration: 200 }));`],
    ["a call that is not an animation", `const go = () => logo.set(Math.max(1, 2));`],
    ["an assignment to a `set` member", `const go = () => { logo.set = withTiming(1, { duration: 200 }); };`]
  ])("ignores %s", (_label, body) => {
    expect(callsiteIds(transform(card(body)))).toEqual([]);
  });

  it("skips dependencies entirely, for both forms", () => {
    const normalized = transform(
      card(`const go = () => { logo.set(withTiming(1, { duration: 200 })); title.y.value = withTiming(0, { duration: 100 }); };`),
      "/repo/node_modules/react-native-chessboard/src/Board.tsx"
    );
    expect(callsiteIds(normalized)).toEqual([]);
    expect(normalized).not.toContain("@runtime-inspector/react-native");
  });

  it("does not make an effect a motion when it also calls `.set` on something else", () => {
    const normalized = transform(
      card(`const analytics = useStore();
  useEffect(() => { logo.set(withSpring(1, { damping: 12 })); analytics.set(Date.now()); }, []);`)
    );
    expect(callsiteIds(normalized)).toHaveLength(1);
    expect(normalized).not.toMatch(/useRiScene\("src\/Card\.tsx:Card\.effect/);
  });

  it("turns a function animating with `.set` into a scene and probes the shared value (RFC 0008)", () => {
    const normalized = transform(
      card(`const replay = () => { logo.set(withTiming(1, { duration: 200 })); };
  useEffect(() => { logo.set(withSpring(1, { damping: 12 })); }, []);`)
    );
    expect(normalized).toMatch(/useRiScene\("src\/Card\.tsx:Card\.replay", \{[^}]*callsites: \["src\/Card\.tsx:12:25:timing:logo"\]/);
    expect(normalized).toMatch(/useRiScene\("src\/Card\.tsx:Card\.effect@13"/);
    expect(normalized).toContain('const _riProbe = useRiProbe("logo"');
  });
});
