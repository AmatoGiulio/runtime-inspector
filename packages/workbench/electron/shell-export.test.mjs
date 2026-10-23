import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateShellFiles, validateShellProject, writeShellProject, syncShellProject } from "./shell-export.mjs";

const makeProject = () => ({
  name: "My iOS App",
  screens: [
    { id: "home", title: "Home", kind: "tab", icon: "house", header: "large", action: "add", linkTo: "details" },
    { id: "discover", title: "Discover", kind: "tab", icon: "safari", header: "inline", action: "none" },
    { id: "details", title: "Details", kind: "page", icon: "square", header: "inline", action: "more" },
    { id: "new-entry", title: "New entry", kind: "modal", icon: "plus", header: "inline", action: "none" }
  ]
});

test("exports real native tabs, stack pages and modal routes", () => {
  const files = generateShellFiles(makeProject());
  assert.match(files["src/app/(tabs)/_layout.tsx"], /NativeTabs\.Trigger/);
  assert.match(files["src/app/(tabs)/_layout.tsx"], /sf="house"/);
  assert.match(files["src/app/_layout.tsx"], /"presentation":"formSheet"/);
  assert.match(files["src/app/(tabs)/home/index.tsx"], /router\.push/);
  assert.match(files["src/app/(tabs)/home/index.tsx"], /Stack\.Toolbar/);
  assert.equal(JSON.parse(files["package.json"]).main, "expo-router/entry");
});

test("rejects duplicate ids, path traversal, broken links and zero tabs", () => {
  const bad = makeProject();
  bad.screens[1].id = "../danger";
  assert.throws(() => validateShellProject(bad), /Invalid screen id/);
  const broken = makeProject();
  broken.screens[0].linkTo = "missing";
  assert.throws(() => validateShellProject(broken), /Broken link/);
  const none = makeProject();
  none.screens = none.screens.filter((s) => s.kind !== "tab");
  assert.throws(() => validateShellProject(none), /between 1 and 5 tabs/);
});

test("writes to empty folder but never overwrites source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shell-studio-"));
  try {
    const result = await writeShellProject(makeProject(), root);
    assert.ok(result.fileCount > 10);
    assert.ok((await fs.readFile(path.join(root, "src/app/_layout.tsx"), "utf8")).includes("RootLayout"));
    await assert.rejects(writeShellProject(makeProject(), root), /not empty/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("live workspace sync preserves user files, updates screens and prunes removed generated routes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shell-studio-sync-"));
  try {
    const first = await syncShellProject(makeProject(), root);
    assert.ok(first.changedFiles > 0);
    const second = await syncShellProject(makeProject(), root);
    assert.equal(second.changedFiles, 0);
    await fs.writeFile(path.join(root, "custom.tsx"), "user file");
    const next = makeProject();
    next.screens = next.screens.filter((screen) => screen.id !== "discover");
    const result = await syncShellProject(next, root);
    assert.ok(result.changedFiles > 0);
    await assert.rejects(fs.stat(path.join(root, "src/app/(tabs)/discover/index.tsx")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(root, "custom.tsx"), "utf8"), "user file");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
