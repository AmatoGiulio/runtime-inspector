/**
 * Parsing for the `// @scene ...` comment (RFC 0008 §4).
 *
 * Syntax, on the leading comment of a motion function's declaration or effect statement:
 *
 *   // @scene "Product reveal" group="Store"   (title and group, both optional, in that order)
 *   // @scene off                              (excludes the function)
 */

export type SceneDirective = { off: true } | { off: false; title?: string; group?: string };

const SCENE_MARKER_RE = /^@scene(?=\s|$)/;
const SCENE_BODY_RE = /^(?:"([^"]*)")?\s*(?:group="([^"]*)")?$/;

export const SCENE_SYNTAX_HINT =
  'Write // @scene "Title" group="Group" (title and group are optional, in that order) or // @scene off.';

/**
 * Returns the parsed directive when `text` (a comment's raw text without the `//` / `/*`
 * markers) is an `@scene` comment, `undefined` when it is not one. Throws when it is an
 * `@scene` comment with invalid syntax.
 */
export function parseSceneComment(text: string): SceneDirective | undefined {
  const trimmed = text.trim();
  if (!SCENE_MARKER_RE.test(trimmed)) return undefined;

  const body = trimmed.slice("@scene".length).trim();
  if (body === "off") return { off: true };

  const match = SCENE_BODY_RE.exec(body);
  if (!match) {
    throw new Error(`invalid // @scene comment "${trimmed}". ${SCENE_SYNTAX_HINT}`);
  }

  const [, title, group] = match;
  if (title !== undefined && title.trim() === "") {
    throw new Error(`invalid // @scene comment "${trimmed}": the title is empty. ${SCENE_SYNTAX_HINT}`);
  }
  if (group !== undefined && group.trim() === "") {
    throw new Error(`invalid // @scene comment "${trimmed}": the group is empty. ${SCENE_SYNTAX_HINT}`);
  }

  return {
    off: false,
    ...(title !== undefined ? { title } : {}),
    ...(group !== undefined ? { group } : {})
  };
}
