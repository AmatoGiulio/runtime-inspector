/**
 * Parsing for the `// @inspect key=value ...` directive comment.
 *
 * Syntax: `@inspect` followed by whitespace-separated `key=value` pairs.
 * Values are either a bare token (number/boolean/identifier-ish) or a
 * double-quoted string (for values containing spaces, e.g. `label="Move X"`).
 */

export type DirectiveValue = string | number;

export interface ParsedDirective {
  raw: Record<string, DirectiveValue>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  label?: string;
}

const DIRECTIVE_RE = /^\s*@inspect(\s+(.*))?$/;

/**
 * Returns the parsed directive if `text` (a comment's raw text, without the
 * leading `//`/`/*` markers) contains an `@inspect` directive - otherwise
 * `undefined`.
 */
export function parseDirectiveComment(text: string): ParsedDirective | undefined {
  const match = DIRECTIVE_RE.exec(text.trim());
  if (!match) return undefined;

  const body = match[2] ?? "";
  const raw: Record<string, DirectiveValue> = {};

  const pairRe = /([a-zA-Z_][a-zA-Z0-9_]*)=("([^"]*)"|[^\s]+)/g;
  let pairMatch: RegExpExecArray | null;
  while ((pairMatch = pairRe.exec(body)) !== null) {
    const key = pairMatch[1];
    const rawValue = pairMatch[3] !== undefined ? pairMatch[3] : pairMatch[2];
    raw[key] = coerceValue(rawValue);
  }

  const parsed: ParsedDirective = { raw };
  if (typeof raw.min === "number") parsed.min = raw.min;
  if (typeof raw.max === "number") parsed.max = raw.max;
  if (typeof raw.step === "number") parsed.step = raw.step;
  if (raw.unit !== undefined) parsed.unit = String(raw.unit);
  if (raw.label !== undefined) parsed.label = String(raw.label);

  return parsed;
}

function coerceValue(value: string): DirectiveValue {
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}
