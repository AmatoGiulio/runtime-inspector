import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Directory holding the CLI's session file: RUNTIME_INSPECTOR_HOME, else ~/.runtime-inspector. */
export function runtimeInspectorHome(env = process.env) {
  return env.RUNTIME_INSPECTOR_HOME || path.join(os.homedir(), ".runtime-inspector");
}

export function runtimeSessionPath(env = process.env) {
  return path.join(runtimeInspectorHome(env), "session.json");
}

/**
 * Reads the session the Runtime Inspector CLI writes on startup
 * (`{ version: 1, brokerUrl, lanBrokerUrl?, token, panelUrl, workspaceRoot, pid, startedAt }`).
 * Returns null when the file is missing, malformed, of another version, or its CLI process is gone.
 */
export async function readRuntimeSession({ env = process.env, isProcessAlive = processIsAlive } = {}) {
  let raw;
  try {
    raw = await readFile(runtimeSessionPath(env), "utf8");
  } catch {
    return null;
  }

  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!session || typeof session !== "object" || session.version !== 1) return null;
  if (typeof session.brokerUrl !== "string" || typeof session.token !== "string") return null;
  if (!Number.isInteger(session.pid) || session.pid <= 0) return null;
  if (!isProcessAlive(session.pid)) return null;
  return session;
}

/** `process.kill(pid, 0)` probes without signalling; EPERM means the process exists but is not ours. */
export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
