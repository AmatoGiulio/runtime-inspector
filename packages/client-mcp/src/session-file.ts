import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Minimal reader for the session file written by `runtime-inspector dev`.
 * The format is owned by packages/cli/src/session-file.ts; this copy is
 * duplicated on purpose so client-mcp does not depend on the CLI package.
 * Keep both in sync:
 * { version: 1, brokerUrl, lanBrokerUrl?, token, panelUrl, workspaceRoot, pid, startedAt }
 */
export interface Session {
  version: 1;
  brokerUrl: string;
  lanBrokerUrl?: string;
  token: string;
  panelUrl: string;
  workspaceRoot: string;
  pid: number;
  startedAt: string;
}

export const DEFAULT_BROKER_URL = "ws://127.0.0.1:4577";

export const NO_BROKER_MESSAGE =
  "No Runtime Inspector session found. Start `runtime-inspector dev` " +
  "(it writes ~/.runtime-inspector/session.json) or set RI_TOKEN/RI_BROKER_URL.";

type Env = Record<string, string | undefined>;

export function sessionFilePath(env: Env = process.env): string {
  return join(env.RUNTIME_INSPECTOR_HOME ?? join(homedir(), ".runtime-inspector"), "session.json");
}

/** Undefined when the file is missing, unparsable, of another version, or its process is gone. */
export function readSessionFile(env: Env = process.env): Session | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(sessionFilePath(env), "utf-8"));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const session = value as Record<string, unknown>;
  if (
    session.version !== 1 ||
    typeof session.brokerUrl !== "string" ||
    typeof session.token !== "string" ||
    typeof session.panelUrl !== "string" ||
    typeof session.workspaceRoot !== "string" ||
    typeof session.pid !== "number" ||
    !Number.isInteger(session.pid) ||
    session.pid <= 0 ||
    typeof session.startedAt !== "string" ||
    (session.lanBrokerUrl !== undefined && typeof session.lanBrokerUrl !== "string")
  ) {
    return undefined;
  }
  return isProcessAlive(session.pid) ? (session as unknown as Session) : undefined;
}

export interface BrokerTarget {
  url: string;
  token?: string;
  source: "env" | "session";
}

/**
 * Where to connect. Explicit env (RI_BROKER_URL and/or RI_TOKEN) wins and is
 * used as-is, as before the session file existed (URL defaults to
 * ws://127.0.0.1:4577). Otherwise the session file is read — on every call,
 * so a restarted `runtime-inspector dev` is picked up. Throws
 * NO_BROKER_MESSAGE when neither is available.
 */
export function resolveBrokerTarget(env: Env = process.env): BrokerTarget {
  if (env.RI_BROKER_URL !== undefined || env.RI_TOKEN !== undefined) {
    return { url: env.RI_BROKER_URL ?? DEFAULT_BROKER_URL, token: env.RI_TOKEN, source: "env" };
  }
  const session = readSessionFile(env);
  if (session) {
    return { url: session.brokerUrl, token: session.token, source: "session" };
  }
  throw new Error(NO_BROKER_MESSAGE);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
