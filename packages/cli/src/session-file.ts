import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The session file is how local tools (Workbench, MCP client) find the
 * running `runtime-inspector dev` broker and its token without the developer
 * copying anything. `runtime-inspector dev` writes it after the broker starts
 * and removes it on shutdown; readers ignore it when the writing process is
 * no longer alive.
 *
 * Format (version 1) — keep in sync with packages/client-mcp/src/session-file.ts:
 * { version: 1, brokerUrl, lanBrokerUrl?, token, panelUrl, workspaceRoot, pid, startedAt }
 */
export const SESSION_FILE_VERSION = 1;

export interface Session {
  version: typeof SESSION_FILE_VERSION;
  brokerUrl: string;
  lanBrokerUrl?: string;
  token: string;
  panelUrl: string;
  workspaceRoot: string;
  pid: number;
  startedAt: string;
}

export function sessionHomeDir(): string {
  return process.env.RUNTIME_INSPECTOR_HOME ?? join(homedir(), ".runtime-inspector");
}

export function sessionFilePath(): string {
  return join(sessionHomeDir(), "session.json");
}

/** Writes the session file atomically (tmp file + rename), dir 0o700, file 0o600. */
export function writeSessionFile(session: Session): string {
  const path = sessionFilePath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
  return path;
}

/**
 * Returns the current session, or undefined when the file is missing,
 * unparsable, of another version, or written by a process that is gone.
 */
export function readSessionFile(): Session | undefined {
  const session = readRawSession();
  if (!session) return undefined;
  return isProcessAlive(session.pid) ? session : undefined;
}

/** Removes the session file only if it was written by `pid`. */
export function removeSessionFile(pid: number): void {
  const session = readRawSession();
  if (!session || session.pid !== pid) return;
  try {
    unlinkSync(sessionFilePath());
  } catch {
    // Already gone.
  }
}

function readRawSession(): Session | undefined {
  let raw: string;
  try {
    raw = readFileSync(sessionFilePath(), "utf-8");
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isSession(value) ? value : undefined;
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === SESSION_FILE_VERSION &&
    typeof candidate.brokerUrl === "string" &&
    (candidate.lanBrokerUrl === undefined || typeof candidate.lanBrokerUrl === "string") &&
    typeof candidate.token === "string" &&
    typeof candidate.panelUrl === "string" &&
    typeof candidate.workspaceRoot === "string" &&
    typeof candidate.pid === "number" &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.startedAt === "string"
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
