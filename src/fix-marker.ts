/** The marker a drafted fix request ends with, written and read here only: the parser dates a fix by it. */

export function fixMarker(ids: string[]): string {
  return `(agentsensei fix ${ids.join(', ')})`;
}

const MARKER = /\(agentsensei fix ([0-9a-f]{6}(?:, [0-9a-f]{6})*)\)/;

/** Fix ids in a developer's prompt, or undefined. */
export function fixIdsIn(text: string): string[] | undefined {
  const m = MARKER.exec(text);
  return m?.[1] === undefined ? undefined : m[1].split(', ');
}
