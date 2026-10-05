import { parse as babelParse } from "@babel/parser";
import type { ParserPlugin } from "@babel/parser";
import { isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import {
  serializeValueExpression,
  type LiteralAnchor,
  type SourceAnchor,
  type SourceApplyErrorCode,
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
 * Walks the whole AST once, calling `onNode` for every node with the names of
 * its enclosing functions/components. Mirrors the babel plugin's
 * `collectEnclosure` semantics: `FunctionDeclaration`s with a name, and
 * `FunctionExpression`/`ArrowFunctionExpression`s assigned to a named
 * `VariableDeclarator`, outermost first; anonymous functions are skipped.
 */
function walkWithEnclosure(
  ast: unknown,
  onNode: (node: AnyNode, enclosure: readonly string[]) => void
): void {
  const enclosureStack: string[] = [];

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

    onNode(node, enclosureStack);

    if (node.type === "FunctionDeclaration") {
      const id = node.id;
      const pushed = isNode(id) && id.type === "Identifier" ? (id.name as string) : undefined;
      if (pushed) enclosureStack.push(pushed);
      visitChildren(node);
      if (pushed) enclosureStack.pop();
      return;
    }

    if (node.type === "VariableDeclarator") {
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
    }

    visitChildren(node);
  }

  visit(ast);
}

/**
 * Collects every `VariableDeclarator` whose name, initializer shape
 * (`useSharedValue(...)`), and enclosing function/component chain match the
 * anchor exactly.
 */
function findCandidates(ast: unknown, anchor: SourceAnchor): Candidate[] {
  const candidates: Candidate[] = [];

  walkWithEnclosure(ast, (node, enclosure) => {
    if (node.type !== "VariableDeclarator") return;

    const id = node.id;
    if (!isNode(id) || id.type !== "Identifier" || id.name !== anchor.name) return;

    const init = node.init;
    if (!isNode(init) || init.type !== "CallExpression") return;
    if (!isUseSharedValueCallee(init.callee)) return;

    if (!arraysEqual([...enclosure], anchor.enclosure)) return;

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
  });

  return candidates;
}

/** The called name of an `Identifier` or non-computed member callee. */
function calleeName(callee: unknown): string | undefined {
  if (!isNode(callee)) return undefined;
  if (callee.type === "Identifier") return callee.name as string;
  if (callee.type === "MemberExpression" && callee.computed !== true) {
    const property = callee.property;
    if (isNode(property) && property.type === "Identifier") return property.name as string;
  }
  return undefined;
}

function callArguments(call: AnyNode): unknown[] {
  return Array.isArray(call.arguments) ? call.arguments : [];
}

/** An animation assignment matching a literal anchor (RFC 0007 §3 step 2). */
interface LiteralCandidate {
  line: number;
  column: number;
  /** The whole right side: `callee(...)` or `withDelay(<arg>, callee(...))`. */
  right: AnyNode;
  /** The `withTiming` / `withSpring` call. */
  animationCall: AnyNode;
  /** The `withDelay` call, when the right side is delayed. */
  delayCall?: AnyNode;
}

/**
 * Collects every `=` assignment whose left-hand text equals the anchor's
 * target (whitespace-insensitive), inside the anchor's enclosure chain, whose
 * right side is `callee(...)` or `withDelay(<arg>, callee(...))`.
 */
function findLiteralCandidates(ast: unknown, code: string, literal: LiteralAnchor): LiteralCandidate[] {
  const candidates: LiteralCandidate[] = [];
  const target = literal.target.replace(/\s+/g, "");

  walkWithEnclosure(ast, (node, enclosure) => {
    if (node.type !== "AssignmentExpression" || node.operator !== "=") return;

    const left = node.left;
    if (!isNode(left) || left.start == null || left.end == null) return;
    if (code.slice(left.start, left.end).replace(/\s+/g, "") !== target) return;

    if (!arraysEqual([...enclosure], literal.enclosure)) return;

    const right = node.right;
    if (!isNode(right) || right.type !== "CallExpression") return;
    if (right.start == null || right.end == null) return;

    const loc = node.loc;
    if (!loc) return;

    let animationCall: AnyNode | undefined;
    let delayCall: AnyNode | undefined;
    if (calleeName(right.callee) === literal.callee) {
      animationCall = right;
    } else if (calleeName(right.callee) === "withDelay") {
      const args = callArguments(right);
      const inner = args[1];
      if (
        args.length === 2 &&
        isNode(inner) &&
        inner.type === "CallExpression" &&
        calleeName(inner.callee) === literal.callee
      ) {
        animationCall = inner;
        delayCall = right;
      }
    }
    if (!animationCall) return;

    candidates.push({ line: loc.start.line, column: loc.start.column, right, animationCall, delayCall });
  });

  return candidates;
}

function isNumericLiteral(node: unknown): node is AnyNode & { start: number; end: number } {
  return isNode(node) && node.type === "NumericLiteral" && node.start != null && node.end != null;
}

/** Whether an object member is keyed by `key` (string-literal keys count even when computed). */
function isMemberKeyed(member: AnyNode, key: string): boolean {
  if (member.type === "SpreadElement") return false;
  const memberKey = member.key;
  if (!isNode(memberKey)) return false;
  if (memberKey.type === "StringLiteral") return memberKey.value === key;
  return member.computed !== true && memberKey.type === "Identifier" && memberKey.name === key;
}

/**
 * The numeric literal of a config parameter (RFC 0007 §3 step 3, the Babel
 * plugin's eligibility rule): the config is an object literal with no spread
 * and exactly one member with that key, a plain non-computed property whose
 * value is a numeric literal.
 */
function locateConfigLiteral(animationCall: AnyNode, key: string): AnyNode | undefined {
  const config = callArguments(animationCall)[1];
  if (!isNode(config) || config.type !== "ObjectExpression") return undefined;
  const properties = Array.isArray(config.properties) ? config.properties.filter(isNode) : [];
  if (properties.some((property) => property.type === "SpreadElement")) return undefined;

  const members = properties.filter((member) => isMemberKeyed(member, key));
  if (members.length !== 1) return undefined;
  const [member] = members;
  if (member.type !== "ObjectProperty" || member.computed === true) return undefined;
  return isNumericLiteral(member.value) ? member.value : undefined;
}

const REANIMATED_MODULE = "react-native-reanimated";

function isValueImportFromReanimated(node: unknown): node is AnyNode {
  if (!isNode(node) || node.type !== "ImportDeclaration") return false;
  const source = node.source;
  if (!isNode(source) || source.value !== REANIMATED_MODULE) return false;
  return node.importKind !== "type" && node.importKind !== "typeof";
}

function importedName(specifier: AnyNode): string | undefined {
  const imported = specifier.imported;
  if (!isNode(imported)) return undefined;
  if (imported.type === "Identifier") return imported.name as string;
  if (imported.type === "StringLiteral") return imported.value as string;
  return undefined;
}

/** How a wrap reaches `withDelay` in a file whose callee is a plain identifier. */
type WithDelayImport =
  | { ok: true; name: string; insertion?: { at: number; text: string } }
  | { ok: false; message: string };

function startLine(node: AnyNode): number | undefined {
  const line = node.loc?.start?.line;
  return typeof line === "number" ? line : undefined;
}

/**
 * What goes between the last named specifier and a new `withDelay`: `, ` for a single-line list;
 * for one specifier per line, a line break plus the last specifier's own indentation, in the
 * file's line ending style.
 */
function namedSpecifierSeparator(source: string, named: AnyNode[]): string {
  const last = named[named.length - 1];
  const lastLine = startLine(last);
  let previousLine: number | undefined;
  if (named.length > 1) {
    previousLine = startLine(named[named.length - 2]);
  } else if (typeof last.start === "number") {
    // A lone specifier is compared with the `{` that opens the list.
    const brace = source.lastIndexOf("{", last.start);
    if (brace >= 0) previousLine = source.slice(0, brace).split("\n").length;
  }
  if (lastLine === undefined || previousLine === undefined || lastLine === previousLine) {
    return ", withDelay";
  }
  const lineStart = source.lastIndexOf("\n", (last.start as number) - 1) + 1;
  const indent = /^[ \t]*/.exec(source.slice(lineStart, last.start as number))?.[0] ?? "";
  return `,${source.includes("\r\n") ? "\r\n" : "\n"}${indent}withDelay`;
}

/**
 * RFC 0007 §3 step 5: the local name of an existing value `withDelay` import
 * from Reanimated (aliases respected), or `withDelay` added as a specifier to
 * the module's first value import from Reanimated that can take one (a
 * default-only import gains `, { withDelay }`).
 */
function resolveWithDelayImport(ast: unknown, source: string): WithDelayImport {
  const program = isNode(ast) && isNode(ast.program) ? ast.program : undefined;
  const body = program && Array.isArray(program.body) ? program.body : [];
  const imports = body.filter(isValueImportFromReanimated);

  for (const declaration of imports) {
    const specifiers = Array.isArray(declaration.specifiers) ? declaration.specifiers.filter(isNode) : [];
    for (const specifier of specifiers) {
      if (specifier.type !== "ImportSpecifier") continue;
      if (specifier.importKind === "type" || specifier.importKind === "typeof") continue;
      if (importedName(specifier) !== "withDelay") continue;
      const local = specifier.local;
      if (isNode(local) && local.type === "Identifier") {
        return { ok: true, name: local.name as string };
      }
    }
  }

  for (const declaration of imports) {
    const specifiers = Array.isArray(declaration.specifiers) ? declaration.specifiers.filter(isNode) : [];
    // A namespace import cannot take named specifiers; a bare `import "..."` has none to extend.
    if (specifiers.length === 0) continue;
    if (specifiers.some((specifier) => specifier.type === "ImportNamespaceSpecifier")) continue;

    const last = specifiers[specifiers.length - 1];
    if (last.end == null) continue;
    const named = specifiers.filter((specifier) => specifier.type === "ImportSpecifier");
    return {
      ok: true,
      name: "withDelay",
      insertion: {
        at: last.end,
        text: named.length > 0 ? namedSpecifierSeparator(source, named) : ", { withDelay }"
      }
    };
  }

  return {
    ok: false,
    message: `no value import from ${REANIMATED_MODULE} to add withDelay to`
  };
}

interface QueuedRequest {
  index: number;
  request: SourceApplyRequest;
}

/**
 * One edit within a file. `replace` swaps `[start, end)` for `text`; `wrap`
 * surrounds `[start, end)` with `prefix` and `suffix`, keeping the text in
 * between, so edits nested inside it still apply (RFC 0007 §3).
 */
type FileEdit = { start: number; end: number; written: string; previous: string } & (
  | { kind: "replace"; text: string }
  | { kind: "wrap"; prefix: string; suffix: string }
);

type AcceptedEdit = FileEdit & { index: number; controlId: string };

type Resolution =
  | { ok: true; edit: FileEdit; insertion?: { at: number; text: string } }
  | { ok: true; noop: { written: string; previous: string } }
  | { ok: false; code: SourceApplyErrorCode; message?: string };

function failure(code: SourceApplyErrorCode, message?: string): Resolution {
  return message === undefined ? { ok: false, code } : { ok: false, code, message };
}

/**
 * RFC 0004 step 4 / RFC 0007 step 2: one candidate is chosen outright;
 * several are filtered by the recorded line/column.
 */
function pickCandidate<T>(
  candidates: T[],
  position: (candidate: T) => { line: number; column: number },
  line: number,
  column: number
): T | SourceApplyErrorCode {
  if (candidates.length === 0) return "DECLARATION_MISSING";
  if (candidates.length === 1) return candidates[0];
  const filtered = candidates.filter((candidate) => {
    const at = position(candidate);
    return at.line === line && at.column === column;
  });
  if (filtered.length === 0) return "DECLARATION_MOVED";
  if (filtered.length > 1) return "DECLARATION_AMBIGUOUS";
  return filtered[0];
}

/** RFC 0004 Part 3: the declaration initializer edit for a `source` anchor. */
function resolveAnchorEdit(
  ast: unknown,
  content: string,
  anchor: SourceAnchor,
  request: SourceApplyRequest
): Resolution {
  const chosen = pickCandidate(
    findCandidates(ast, anchor),
    (candidate) => ({ line: candidate.declaratorLine, column: candidate.declaratorColumn }),
    anchor.line,
    anchor.column
  );
  if (typeof chosen === "string") return failure(chosen);

  const currentInitText = content.slice(chosen.argStart, chosen.argEnd);
  if (currentInitText !== anchor.init) return failure("EXPRESSION_MISMATCH");

  let expr: string;
  try {
    expr = serializeValueExpression(request.kind, request.value);
  } catch (error) {
    return failure("WRITE_FAILURE", error instanceof Error ? error.message : String(error));
  }

  return {
    ok: true,
    edit: {
      kind: "replace",
      start: chosen.argStart,
      end: chosen.argEnd,
      text: expr,
      written: expr,
      previous: currentInitText
    }
  };
}

/** RFC 0007 §3: the edit for an animation `literal` anchor. */
function resolveLiteralEdit(
  ast: unknown,
  content: string,
  literal: LiteralAnchor,
  value: unknown,
  withDelayImport: () => WithDelayImport
): Resolution {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return failure("WRITE_FAILURE", "a literal value must be a finite number");
  }

  const chosen = pickCandidate(
    findLiteralCandidates(ast, content, literal),
    (candidate) => candidate,
    literal.line,
    literal.column
  );
  if (typeof chosen === "string") return failure(chosen);

  const written = String(value);
  let node: AnyNode | undefined;

  if (literal.parameter === "delay") {
    if (literal.init === null) {
      if (chosen.delayCall) return failure("EXPRESSION_MISMATCH", "the call now has a withDelay");
      if (value === 0) return { ok: true, noop: { written: "0", previous: "0" } };

      const callee = chosen.animationCall.callee;
      let name: string;
      let insertion: { at: number; text: string } | undefined;
      if (isNode(callee) && callee.type === "MemberExpression") {
        const object = callee.object;
        if (!isNode(object) || object.start == null || object.end == null) {
          return failure("DECLARATION_MISSING");
        }
        name = `${content.slice(object.start, object.end)}.withDelay`;
      } else {
        const resolved = withDelayImport();
        if (!resolved.ok) return failure("DECLARATION_MISSING", resolved.message);
        name = resolved.name;
        insertion = resolved.insertion;
      }

      return {
        ok: true,
        edit: {
          kind: "wrap",
          start: chosen.right.start as number,
          end: chosen.right.end as number,
          prefix: `${name}(${written}, `,
          suffix: ")",
          written,
          previous: "0"
        },
        insertion
      };
    }

    if (!chosen.delayCall) return failure("EXPRESSION_MISMATCH", "the call no longer has a withDelay");
    const delay = callArguments(chosen.delayCall)[0];
    if (!isNumericLiteral(delay)) return failure("DECLARATION_MISSING", "the delay is no longer a numeric literal");
    node = delay;
  } else {
    node = locateConfigLiteral(chosen.animationCall, literal.parameter);
    if (!node) return failure("DECLARATION_MISSING", `${literal.parameter} is no longer a numeric literal`);
  }

  const start = node.start as number;
  const end = node.end as number;
  const previous = content.slice(start, end);
  if (previous !== literal.init) return failure("EXPRESSION_MISMATCH");

  return { ok: true, edit: { kind: "replace", start, end, text: written, written, previous } };
}

function contains(outer: FileEdit, inner: FileEdit): boolean {
  return (
    outer.start <= inner.start &&
    inner.end <= outer.end &&
    (outer.start !== inner.start || outer.end !== inner.end)
  );
}

/** Overlapping edits conflict, except an edit nested inside a wrap (RFC 0007 §3). */
function conflicts(edit: FileEdit, accepted: readonly FileEdit[]): boolean {
  return accepted.some((other) => {
    if (!(edit.start < other.end && other.start < edit.end)) return false;
    if (other.kind === "wrap" && contains(other, edit)) return false;
    if (edit.kind === "wrap" && contains(edit, other)) return false;
    return true;
  });
}

/**
 * Applies a batch of `source.apply` requests against the real (or fake, for
 * tests) filesystem, following the procedure in RFC 0004 Part 3 for `anchor`
 * requests and RFC 0007 §3 for `literal` requests. Requests are grouped by
 * resolved file path so each file is read and written at most once; within a
 * file, accepted edits are spliced from the end of the file toward the
 * beginning so earlier byte offsets (computed once, from the original
 * content) stay valid.
 */
export async function applySourceRequests(
  requests: SourceApplyRequest[],
  options: SourceApplyOptions
): Promise<SourceApplyResultEntry[]> {
  const results = new Array<SourceApplyResultEntry>(requests.length);
  const groups = new Map<string, QueuedRequest[]>();

  requests.forEach((request, index) => {
    const anchorFile = request.literal !== undefined ? request.literal.file : request.anchor.file;
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

  let withDelayImport: WithDelayImport | undefined;
  const resolveImportOnce = () => (withDelayImport ??= resolveWithDelayImport(ast, content));

  const accepted: AcceptedEdit[] = [];
  // At most one import insertion per file, however many wraps share it.
  let importInsertion: { at: number; text: string } | undefined;

  for (const { index, request } of group) {
    const resolution =
      request.literal !== undefined
        ? resolveLiteralEdit(ast, content, request.literal, request.value, resolveImportOnce)
        : resolveAnchorEdit(ast, content, request.anchor, request);

    if (!resolution.ok) {
      results[index] = {
        controlId: request.controlId,
        ok: false,
        code: resolution.code,
        ...(resolution.message !== undefined ? { message: resolution.message } : {})
      };
      continue;
    }

    if ("noop" in resolution) {
      results[index] = { controlId: request.controlId, ok: true, ...resolution.noop };
      continue;
    }

    if (conflicts(resolution.edit, accepted)) {
      results[index] = {
        controlId: request.controlId,
        ok: false,
        code: "WRITE_FAILURE",
        message: "overlapping edit"
      };
      continue;
    }

    accepted.push({ ...resolution.edit, index, controlId: request.controlId });
    importInsertion ??= resolution.insertion;
  }

  if (accepted.length === 0) return;

  // A wrap becomes two insertions around its range, so the edits nested inside
  // it are applied first and the wrap surrounds the updated text.
  const splices: Array<{ start: number; end: number; text: string }> = [];
  for (const edit of accepted) {
    if (edit.kind === "replace") {
      splices.push({ start: edit.start, end: edit.end, text: edit.text });
    } else {
      splices.push({ start: edit.start, end: edit.start, text: edit.prefix });
      splices.push({ start: edit.end, end: edit.end, text: edit.suffix });
    }
  }
  if (importInsertion) {
    splices.push({ start: importInsertion.at, end: importInsertion.at, text: importInsertion.text });
  }

  const sortedDesc = splices.sort((a, b) => b.start - a.start || b.end - a.end);
  let nextContent = content;
  for (const splice of sortedDesc) {
    nextContent = nextContent.slice(0, splice.start) + splice.text + nextContent.slice(splice.end);
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
      written: edit.written,
      previous: edit.previous
    };
  }
}
