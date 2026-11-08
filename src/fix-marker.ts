/** The marker a drafted fix request ends with, written and read here only: the parser dates a fix by it. */

export function fixMarker(ids: string[]): string {
  return `(vibesenpai fix ${ids.join(', ')})`;
}

// `agentsensei` is the old name; fixes applied before the rename still date. DECISIONS.md D68.
const MARKER = /\((?:vibesenpai|agentsensei) fix ([0-9a-f]{6}(?:, [0-9a-f]{6})*)\)/;

/** Fix ids in a developer's prompt, or undefined. */
export function fixIdsIn(text: string): string[] | undefined {
  const m = MARKER.exec(text);
  return m?.[1] === undefined ? undefined : m[1].split(', ');
}
