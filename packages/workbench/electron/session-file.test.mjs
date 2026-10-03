import test from "node:test";
import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  processIsAlive,
  readRuntimeSession,
  runtimeInspectorHome,
  runtimeSessionPath
} from "./session-file.mjs";

async function withHome(callback) {
  const home = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ri-session-"));
  try {
    await callback(home, { RUNTIME_INSPECTOR_HOME: home });
  } finally {
    await fsPromises.rm(home, { recursive: true, force: true });
  }
}

function session(overrides = {}) {
  return {
    version: 1,
    brokerUrl: "ws://127.0.0.1:4577",
    lanBrokerUrl: "ws://192.168.1.20:4577",
    token: "secret-token",
    panelUrl: "http://127.0.0.1:4600/?token=secret-token",
    workspaceRoot: "/repo/app",
    pid: process.pid,
    startedAt: "2026-10-03T12:00:00.000Z",
    ...overrides
  };
}

async function writeSession(home, value) {
  await fsPromises.writeFile(
    path.join(home, "session.json"),
    typeof value === "string" ? value : JSON.stringify(value)
  );
}

test("session path honours RUNTIME_INSPECTOR_HOME, else ~/.runtime-inspector", () => {
  assert.equal(runtimeInspectorHome({ RUNTIME_INSPECTOR_HOME: "/tmp/ri" }), "/tmp/ri");
  assert.equal(runtimeSessionPath({ RUNTIME_INSPECTOR_HOME: "/tmp/ri" }), "/tmp/ri/session.json");
  assert.equal(
    runtimeSessionPath({}),
    path.join(os.homedir(), ".runtime-inspector", "session.json")
  );
});

test("reads a valid session whose CLI process is alive", async () => {
  await withHome(async (home, env) => {
    await writeSession(home, session());
    assert.deepEqual(await readRuntimeSession({ env }), session());
  });
});

test("returns null when the session file is missing", async () => {
  await withHome(async (_home, env) => {
    assert.equal(await readRuntimeSession({ env }), null);
  });
});

test("returns null for malformed JSON or another version", async () => {
  await withHome(async (home, env) => {
    await writeSession(home, "{not json");
    assert.equal(await readRuntimeSession({ env }), null);

    await writeSession(home, session({ version: 2 }));
    assert.equal(await readRuntimeSession({ env }), null);

    await writeSession(home, session({ token: undefined }));
    assert.equal(await readRuntimeSession({ env }), null);
  });
});

test("returns null when the CLI process is gone", async () => {
  await withHome(async (home, env) => {
    await writeSession(home, session({ pid: 424242 }));
    const probed = [];
    const result = await readRuntimeSession({
      env,
      isProcessAlive: (pid) => {
        probed.push(pid);
        return false;
      }
    });
    assert.equal(result, null);
    assert.deepEqual(probed, [424242]);
  });
});

test("processIsAlive: own pid alive, EPERM counts as alive, ESRCH does not", (t) => {
  assert.equal(processIsAlive(process.pid), true);

  const kill = t.mock.method(process, "kill", () => {
    throw Object.assign(new Error("not permitted"), { code: "EPERM" });
  });
  assert.equal(processIsAlive(1), true);

  kill.mock.mockImplementation(() => {
    throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  });
  assert.equal(processIsAlive(424242), false);
  assert.deepEqual(kill.mock.calls.at(-1).arguments, [424242, 0]);
});
