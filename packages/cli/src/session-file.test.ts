import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readSessionFile,
  removeSessionFile,
  sessionFilePath,
  writeSessionFile,
  type Session
} from "./session-file";

let home: string;
const previousHome = process.env.RUNTIME_INSPECTOR_HOME;

beforeEach(() => {
  home = join(mkdtempSync(join(tmpdir(), "ri-session-")), "home");
  process.env.RUNTIME_INSPECTOR_HOME = home;
});

afterEach(() => {
  rmSync(join(home, ".."), { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.RUNTIME_INSPECTOR_HOME;
  else process.env.RUNTIME_INSPECTOR_HOME = previousHome;
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    version: 1,
    brokerUrl: "ws://127.0.0.1:4577",
    lanBrokerUrl: "ws://192.168.1.2:4577",
    token: "c2dfb24d",
    panelUrl: "http://127.0.0.1:4600?token=c2dfb24d",
    workspaceRoot: "/abs/path",
    pid: process.pid,
    startedAt: "2026-10-03T21:00:00.000Z",
    ...overrides
  };
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
}

describe("session file", () => {
  it("lives under RUNTIME_INSPECTOR_HOME", () => {
    expect(sessionFilePath()).toBe(join(home, "session.json"));
  });

  it("writes atomically with private permissions and reads it back", () => {
    const session = makeSession();
    const path = writeSessionFile(session);

    expect(path).toBe(sessionFilePath());
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(home)).toEqual(["session.json"]);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(session);
    expect(readSessionFile()).toEqual(session);
  });

  it("accepts a session without lanBrokerUrl", () => {
    const { lanBrokerUrl: _omit, ...session } = makeSession();
    writeSessionFile(session);
    expect(readSessionFile()).toEqual(session);
  });

  it("returns undefined when the file is missing", () => {
    expect(readSessionFile()).toBeUndefined();
  });

  it("returns undefined when the file is unparsable or has the wrong version", () => {
    writeSessionFile(makeSession());
    writeFileSync(sessionFilePath(), "{not json");
    expect(readSessionFile()).toBeUndefined();

    writeFileSync(sessionFilePath(), JSON.stringify({ ...makeSession(), version: 2 }));
    expect(readSessionFile()).toBeUndefined();

    writeFileSync(sessionFilePath(), JSON.stringify({ ...makeSession(), token: 42 }));
    expect(readSessionFile()).toBeUndefined();
  });

  it("returns undefined when the writing process is gone", () => {
    writeSessionFile(makeSession({ pid: deadPid() }));
    expect(readSessionFile()).toBeUndefined();
  });

  it("removes the file only for the pid that wrote it", () => {
    writeSessionFile(makeSession({ pid: process.pid }));

    removeSessionFile(process.pid + 1);
    expect(readSessionFile()).toBeDefined();

    removeSessionFile(process.pid);
    expect(readSessionFile()).toBeUndefined();
    expect(readdirSync(home)).toEqual([]);
  });

  it("removeSessionFile is a no-op when there is no file", () => {
    expect(() => removeSessionFile(process.pid)).not.toThrow();
  });
});
