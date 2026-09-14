export function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function stddev(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  const variance = mean(nums.map((n) => (n - m) ** 2));
  return Math.sqrt(variance);
}

/** Index (0-based) of the first item matching `isRelevant`, or -1 if none does. */
export function firstRelevantIndex<T>(items: T[], isRelevant: (item: T) => boolean): number {
  return items.findIndex(isRelevant);
}

export function reciprocalRank(rankIndex: number): number {
  return rankIndex === -1 ? 0 : 1 / (rankIndex + 1);
}

export function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}
