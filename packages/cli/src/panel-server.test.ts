import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasBundledPanel, resolvePanelFile, startPanelServer } from "./panel-server.js";

function makePanelDir() {
  const root = mkdtempSync(join(tmpdir(), "ri-panel-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
  return root;
}

describe("resolvePanelFile", () => {
  it("serves files inside the panel directory and falls back to index.html", () => {
    const root = makePanelDir();
    expect(resolvePanelFile(root, "/assets/app.js")).toBe(join(root, "assets", "app.js"));
    expect(resolvePanelFile(root, "/?token=abc&broker=ws%3A%2F%2F127.0.0.1%3A4577")).toBe(join(root, "index.html"));
    expect(resolvePanelFile(root, "/missing.js")).toBe(join(root, "index.html"));
  });

  it("refuses paths that escape the panel directory", () => {
    const root = makePanelDir();
    expect(resolvePanelFile(root, "/..%2F..%2Fetc%2Fpasswd")).toBeUndefined();
    expect(resolvePanelFile(root, "/%2e%2e/%2e%2e/etc/passwd")).toBe(join(root, "index.html"));
    expect(resolvePanelFile(root, "/%E0%A4%A")).toBeUndefined();
  });

  it("detects a bundled panel only when index.html exists", () => {
    expect(hasBundledPanel(makePanelDir())).toBe(true);
    expect(hasBundledPanel(mkdtempSync(join(tmpdir(), "ri-empty-")))).toBe(false);
  });
});

describe("startPanelServer", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it("serves the panel with content types and rejects writes", async () => {
    const root = makePanelDir();
    const server = await startPanelServer({ rootDir: root, host: "127.0.0.1", port: 0 });
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const page = await fetch(`${base}/?token=abc`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("id=root");

    const script = await fetch(`${base}/assets/app.js`);
    expect(script.headers.get("content-type")).toContain("text/javascript");

    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
  });
});
