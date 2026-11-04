import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Expo SDK 52 enables Metro's experimental import support whenever the React Compiler is
// on. That transform copies named imports into locals when a module loads, so an import
// cycle through `./index` leaves them `undefined` ("triggerControl is not a function").
// Internal modules therefore import from the module that defines what they use.

const srcDir = __dirname;

function sourceModules(): string[] {
  return readdirSync(srcDir).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")
  );
}

function localImports(file: string): string[] {
  const code = readFileSync(join(srcDir, file), "utf8");
  const imports: string[] = [];
  for (const match of code.matchAll(/(?:import|export)[^;]*?from\s+"(\.\/[^"]+)"/g)) {
    imports.push(match[1].slice(2));
  }
  return imports;
}

describe("runtime import graph", () => {
  it("never imports the public entry from an internal module", () => {
    const offenders = sourceModules()
      .filter((file) => file !== "index.ts")
      .filter((file) => localImports(file).includes("index"));
    expect(offenders).toEqual([]);
  });

  it("has no import cycles between internal modules", () => {
    const graph = new Map<string, string[]>();
    for (const file of sourceModules()) {
      graph.set(file.replace(/\.ts$/, ""), localImports(file));
    }
    const cycles: string[] = [];
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (node: string, path: string[]) => {
      if (done.has(node)) return;
      if (visiting.has(node)) {
        cycles.push([...path.slice(path.indexOf(node)), node].join(" -> "));
        return;
      }
      visiting.add(node);
      for (const next of graph.get(node) ?? []) {
        if (graph.has(next)) visit(next, [...path, node]);
      }
      visiting.delete(node);
      done.add(node);
    };
    for (const node of graph.keys()) visit(node, []);
    expect(cycles).toEqual([]);
  });
});
