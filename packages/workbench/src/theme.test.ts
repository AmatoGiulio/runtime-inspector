import { describe, expect, it } from "vitest";
import {
  nextThemeChoice,
  parseThemeChoice,
  resolveTheme,
  themeChoiceLabel,
  type ThemeChoice
} from "./theme";

describe("resolveTheme", () => {
  it("follows the system preference for system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("ignores the system preference for an explicit choice", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("nextThemeChoice", () => {
  it("cycles system -> light -> dark -> system", () => {
    expect(nextThemeChoice("system")).toBe("light");
    expect(nextThemeChoice("light")).toBe("dark");
    expect(nextThemeChoice("dark")).toBe("system");
  });
});

describe("parseThemeChoice", () => {
  it("accepts the three valid choices", () => {
    for (const choice of ["system", "light", "dark"] as ThemeChoice[]) {
      expect(parseThemeChoice(choice)).toBe(choice);
    }
  });

  it("falls back to system for anything else", () => {
    expect(parseThemeChoice(null)).toBe("system");
    expect(parseThemeChoice(undefined)).toBe("system");
    expect(parseThemeChoice("Dark")).toBe("system");
    expect(parseThemeChoice("")).toBe("system");
    expect(parseThemeChoice(42)).toBe("system");
    expect(parseThemeChoice({})).toBe("system");
  });
});

describe("themeChoiceLabel", () => {
  it("labels each choice", () => {
    expect(themeChoiceLabel("system")).toBe("Auto");
    expect(themeChoiceLabel("light")).toBe("Light");
    expect(themeChoiceLabel("dark")).toBe("Dark");
  });
});
