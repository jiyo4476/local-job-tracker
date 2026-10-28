export interface ValueReplacement {
  find: string;
  replacement: string;
}

export const URL_ATTRIBUTES = [
  'href',
  'formaction',
  'data-href',
  'data-url',
] as const;

// Literal, first-occurrence replacement: no regex, so page-independent
// templates cannot introduce pattern-injection or backtracking surprises.
export function applyReplacement(
  value: string,
  replace: ValueReplacement | undefined,
): string {
  if (!replace) return value;
  const index = value.indexOf(replace.find);
  if (index < 0) return value;
  return (
    value.slice(0, index) +
    replace.replacement +
    value.slice(index + replace.find.length)
  );
}
