import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NO_BROKER_MESSAGE, readSessionFile, resolveBrokerTarget, sessionFilePath } from "./session-file";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ri-mcp-session-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeSession(overrides: Record<string, unknown> = {}) {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "session.json"),
    JSON.stringify({
      version: 1,
      brokerUrl: "ws://127.0.0.1:4578",
      token: "c2dfb24d",
      panelUrl: "http://127.0.0.1:4600?token=c2dfb24d",
      workspaceRoot: "/abs/path",
      pid: process.pid,
      startedAt: "2026-10-03T21:00:00.000Z",
      ...overrides
    })
  );
}

describe("session file (client-mcp reader)", () => {
  it("reads the file under RUNTIME_INSPECTOR_HOME", () => {
    const env = { RUNTIME_INSPECTOR_HOME: home };
    expect(sessionFilePath(env)).toBe(join(home, "session.json"));
    expect(readSessionFile(env)).toBeUndefined();
    writeSession();
    expect(readSessionFile(env)?.token).toBe("c2dfb24d");
  });

  it("ignores wrong versions, bad JSON and dead processes", () => {
    const env = { RUNTIME_INSPECTOR_HOME: home };
    writeSession({ version: 2 });
    expect(readSessionFile(env)).toBeUndefined();
    writeFileSync(join(home, "session.json"), "{");
    expect(readSessionFile(env)).toBeUndefined();
    writeSession({ pid: spawnSync(process.execPath, ["-e", ""]).pid });
    expect(readSessionFile(env)).toBeUndefined();
  });

  it("uses the session file when RI_TOKEN / RI_BROKER_URL are not set", () => {
    writeSession();
    expect(resolveBrokerTarget({ RUNTIME_INSPECTOR_HOME: home })).toEqual({
      url: "ws://127.0.0.1:4578",
      token: "c2dfb24d",
      source: "session"
    });
  });

  it("env wins over the session file", () => {
    writeSession();
    expect(
      resolveBrokerTarget({ RUNTIME_INSPECTOR_HOME: home, RI_BROKER_URL: "ws://10.0.0.1:9000", RI_TOKEN: "envtoken" })
    ).toEqual({ url: "ws://10.0.0.1:9000", token: "envtoken", source: "env" });
    // Env is used as-is: a lone RI_TOKEN keeps the historical default URL, the file is not mixed in.
    expect(resolveBrokerTarget({ RUNTIME_INSPECTOR_HOME: home, RI_TOKEN: "envtoken" })).toEqual({
      url: "ws://127.0.0.1:4577",
      token: "envtoken",
      source: "env"
    });
    expect(resolveBrokerTarget({ RUNTIME_INSPECTOR_HOME: home, RI_BROKER_URL: "ws://10.0.0.1:9000" })).toEqual({
      url: "ws://10.0.0.1:9000",
      token: undefined,
      source: "env"
    });
  });

  it("re-reads the file on every call (a restarted CLI is picked up)", () => {
    const env = { RUNTIME_INSPECTOR_HOME: home };
    writeSession({ token: "first" });
    expect(resolveBrokerTarget(env).token).toBe("first");
    writeSession({ token: "second", brokerUrl: "ws://127.0.0.1:4579" });
    expect(resolveBrokerTarget(env)).toMatchObject({ token: "second", url: "ws://127.0.0.1:4579" });
  });

  it("explains how to start a session when neither env nor file is available", () => {
    expect(() => resolveBrokerTarget({ RUNTIME_INSPECTOR_HOME: home })).toThrow(NO_BROKER_MESSAGE);
    expect(NO_BROKER_MESSAGE).toContain(
      "Start `runtime-inspector dev` (it writes ~/.runtime-inspector/session.json) or set RI_TOKEN/RI_BROKER_URL."
    );
  });
});
