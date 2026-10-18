/** Return `value` limited to the range from `low` to `high`. */
export function clamp(value: number, low: number, high: number): number {
	return Math.max(low, Math.min(value, high));
}
