/** Provider-reported accounting only. Missing or invalid values stay unknown. */
export function reportedNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function reportedSum(...values: unknown[]): number | undefined {
  const known = values.map(reportedNumber).filter((value): value is number => value !== undefined);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : undefined;
}
