// Position of the instant pace on the gauge (0 = left edge, 1 = right edge), on a
// logarithmic scale of the ratio pace / target: the target sits still in the middle
// and equal ratios are equal distances — ½× at a quarter, 2× at three quarters, 4×
// and beyond at the end. The old linear scale adapted to the larger of the two
// values, so the target marker moved whenever the pace changed and the bar seemed to
// jump without a real change. The numbers shown next to the bar stay the real %/h.

export const GAUGE_TARGET_POSITION = 0.5;
// Ratios marked on the track besides the target.
export const GAUGE_TICK_RATIOS = [0.5, 2] as const;
// A consumption above zero but far below the target stays visible.
const MIN_VISIBLE_POSITION = 0.02;

export function gaugePosition(instant: number, target: number): number {
  if (instant <= 0) return 0;
  if (target <= 0) return 1;
  const position = GAUGE_TARGET_POSITION + Math.log2(instant / target) / 4;
  return Math.min(1, Math.max(MIN_VISIBLE_POSITION, position));
}
