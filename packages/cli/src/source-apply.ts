import { parse as babelParse } from "@babel/parser";
import type { ParserPlugin } from "@babel/parser";
import { isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import {
  serializeValueExpression,
  type SourceAnchor,
  type SourceApplyRequest,
  type SourceApplyResultEntry
} from "@runtime-inspector/protocol";

/**
 * Filesystem/parsing seams injected for testability (RFC 0004, Part 3).
 * `rootDir` is the workspace root every `anchor.file` is resolved against;
 * a resolved path that escapes it is rejected as a `WRITE_FAILURE` rather
 * than ever being read or written.
 */
export interface SourceApplyOptions {
  rootDir: string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  parse?(code: string): unknown;
}

const PARSER_PLUGINS: ParserPlugin[] = ["typescript", "jsx"];

function defaultParse(code: string): unknown {
  return babelParse(code, { sourceType: "module", plugins: PARSER_PLUGINS });
}

/**
 * Minimal structural view of a Babel AST node used by the local walker
 * below. Deliberately untyped beyond `type`/`start`/`end`/`loc` — the walk
 * is generic over arbitrary node shapes and does not depend on
 * `@babel/traverse` or `@babel/types`.
 */
interface AnyNode {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
}

function isNode(value: unknown): value is AnyNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

interface Candidate {
  declaratorLine: number;
  declaratorColumn: number;
  argStart: number;
  argEnd: number;
}

function isUseSharedValueCallee(callee: unknown): boolean {
  if (!isNode(callee)) return false;
  if (callee.type === "Identifier") return callee.name === "useSharedValue";
  if (callee.type === "MemberExpression" && callee.computed !== true) {
    const property = callee.property;
    return isNode(property) && property.type === "Identifier" && property.name === "useSharedValue";
  }
  return false;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Walks the whole AST once, collecting every `VariableDeclarator` whose
 * name, initializer shape (`useSharedValue(...)`), and enclosing
 * function/component chain match the anchor exactly. Mirrors the babel
 * plugin's `collectEnclosure` semantics: `FunctionDeclaration`s with a name,
 * and `FunctionExpression`/`ArrowFunctionExpression`s assigned to a named
 * `VariableDeclarator`, outermost first; anonymous functions are skipped.
 */
function findCandidates(ast: unknown, anchor: SourceAnchor): Candidate[] {
  const candidates: Candidate[] = [];
  const enclosureStack: string[] = [];

  function maybeRecordCandidate(node: AnyNode): void {
    const id = node.id;
    if (!isNode(id) || id.type !== "Identifier" || id.name !== anchor.name) return;

    const init = node.init;
    if (!isNode(init) || init.type !== "CallExpression") return;
    if (!isUseSharedValueCallee(init.callee)) return;

    if (!arraysEqual(enclosureStack, anchor.enclosure)) return;

    const args = init.arguments;
    const firstArg = Array.isArray(args) ? args[0] : undefined;
    if (!isNode(firstArg) || firstArg.start == null || firstArg.end == null) return;

    const loc = node.loc;
    if (!loc) return;

    candidates.push({
      declaratorLine: loc.start.line,
      declaratorColumn: loc.start.column,
      argStart: firstArg.start,
      argEnd: firstArg.end
    });
  }

  function visitChildren(node: AnyNode): void {
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end" || key === "range") continue;
      visit(node[key]);
    }
  }

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isNode(node)) return;

    if (node.type === "FunctionDeclaration") {
      const id = node.id;
      const pushed = isNode(id) && id.type === "Identifier" ? (id.name as string) : undefined;
      if (pushed) enclosureStack.push(pushed);
      visitChildren(node);
      if (pushed) enclosureStack.pop();
      return;
    }

    if (node.type === "VariableDeclarator") {
      maybeRecordCandidate(node);

      const id = node.id;
      const init = node.init;
      if (
        isNode(init) &&
        (init.type === "FunctionExpression" || init.type === "ArrowFunctionExpression") &&
        isNode(id) &&
        id.type === "Identifier"
      ) {
        enclosureStack.push(id.name as string);
        visit(init);
        enclosureStack.pop();
        return;
      }

      visitChildren(node);
      return;
    }

    visitChildren(node);
  }

  visit(ast);
  return candidates;
}

interface QueuedRequest {
  index: number;
  request: SourceApplyRequest;
}

interface AcceptedEdit {
  index: number;
  controlId: string;
  start: number;
  end: number;
  expr: string;
  previous: string;
}

/**
 * Applies a batch of `source.apply` requests against the real (or fake, for
 * tests) filesystem, following the procedure in RFC 0004 Part 3. Requests
 * are grouped by resolved file path so each file is read and written at
 * most once; within a file, accepted edits are spliced from the end of the
 * file toward the beginning so earlier byte offsets (computed once, from
 * the original content) stay valid.
 */
export async function applySourceRequests(
  requests: SourceApplyRequest[],
  options: SourceApplyOptions
): Promise<SourceApplyResultEntry[]> {
  const results = new Array<SourceApplyResultEntry>(requests.length);
  const groups = new Map<string, QueuedRequest[]>();

  requests.forEach((request, index) => {
    const anchorFile = request.anchor.file;
    const resolved = resolvePath(options.rootDir, anchorFile);
    const rel = relativePath(options.rootDir, resolved);
    const isInside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));

    if (!isInside) {
      results[index] = {
        controlId: request.controlId,
        ok: false,
        code: "WRITE_FAILURE",
        message: `path outside workspace root: ${anchorFile}`
      };
      return;
    }

    const group = groups.get(resolved) ?? [];
    group.push({ index, request });
    groups.set(resolved, group);
  });

  for (const [resolvedPath, group] of groups) {
    await processFileGroup(resolvedPath, group, options, results);
  }

  return results;
}

async function processFileGroup(
  resolvedPath: string,
  group: QueuedRequest[],
  options: SourceApplyOptions,
  results: SourceApplyResultEntry[]
): Promise<void> {
  let content: string;
  try {
    content = await options.readFile(resolvedPath);
  } catch {
    const message = `declaration file not found: ${resolvedPath}`;
    for (const { index, request } of group) {
      results[index] = { controlId: request.controlId, ok: false, code: "DECLARATION_MISSING", message };
    }
    return;
  }

  let ast: unknown;
  try {
    ast = (options.parse ?? defaultParse)(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const { index, request } of group) {
      results[index] = { controlId: request.controlId, ok: false, code: "PARSE_FAILURE", message };
    }
    return;
  }

  const accepted: AcceptedEdit[] = [];

  for (const { index, request } of group) {
    const candidates = findCandidates(ast, request.anchor);

    let chosen: Candidate | undefined;
    if (candidates.length === 0) {
      results[index] = { controlId: request.controlId, ok: false, code: "DECLARATION_MISSING" };
      continue;
    } else if (candidates.length === 1) {
      chosen = candidates[0];
    } else {
      const filtered = candidates.filter(
        (candidate) =>
          candidate.declaratorLine === request.anchor.line &&
          candidate.declaratorColumn === request.anchor.column
      );
      if (filtered.length === 0) {
        results[index] = { controlId: request.controlId, ok: false, code: "DECLARATION_MOVED" };
        continue;
      }
      if (filtered.length > 1) {
        results[index] = { controlId: request.controlId, ok: false, code: "DECLARATION_AMBIGUOUS" };
        continue;
      }
      chosen = filtered[0];
    }

    const currentInitText = content.slice(chosen.argStart, chosen.argEnd);
    if (currentInitText !== request.anchor.init) {
      results[index] = { controlId: request.controlId, ok: false, code: "EXPRESSION_MISMATCH" };
      continue;
    }

    let expr: string;
    try {
      expr = serializeValueExpression(request.kind, request.value);
    } catch (error) {
      results[index] = {
        controlId: request.controlId,
        ok: false,
        code: "WRITE_FAILURE",
        message: error instanceof Error ? error.message : String(error)
      };
      continue;
    }

    const overlaps = accepted.some((edit) => chosen!.argStart < edit.end && edit.start < chosen!.argEnd);
    if (overlaps) {
      results[index] = {
        controlId: request.controlId,
        ok: false,
        code: "WRITE_FAILURE",
        message: "overlapping edit"
      };
      continue;
    }

    accepted.push({
      index,
      controlId: request.controlId,
      start: chosen.argStart,
      end: chosen.argEnd,
      expr,
      previous: currentInitText
    });
  }

  if (accepted.length === 0) return;

  const sortedDesc = [...accepted].sort((a, b) => b.start - a.start);
  let nextContent = content;
  for (const edit of sortedDesc) {
    nextContent = nextContent.slice(0, edit.start) + edit.expr + nextContent.slice(edit.end);
  }

  try {
    await options.writeFile(resolvedPath, nextContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const edit of accepted) {
      results[edit.index] = { controlId: edit.controlId, ok: false, code: "WRITE_FAILURE", message };
    }
    return;
  }

  for (const edit of accepted) {
    results[edit.index] = {
      controlId: edit.controlId,
      ok: true,
      written: edit.expr,
      previous: edit.previous
    };
  }
}
