/**
 * Render time budget. Still images look identical at lower frame rates, so when a render is on course to overrun the time budget
 * (e.g. a free 0.1-CPU instance), the planner steps the FRAME RATE down (never resolution) and the render is restarted once with a cheaper rate.
 * Encoding cost is roughly proportional to the number of encoded frames, i.e. to fps.
 */
export const FPS_STEPS = [60, 30, 25, 24, 15, 12, 10, 8, 6, 5, 4, 3, 2];
export const fpsLadder = (configuredFps) => [configuredFps, ...FPS_STEPS.filter((f) => f < configuredFps)];

/** Projected total wall time from progress so far. null until there is enough signal. */
export function projectTotalMs({ elapsedMs, renderedSeconds, totalSeconds, minSampleMs = 30_000 }) {
  if (!(renderedSeconds > 0) || !(totalSeconds > 0) || elapsedMs < minSampleMs || renderedSeconds < Math.min(3, totalSeconds * 0.03)) return null;
  return (elapsedMs * totalSeconds) / renderedSeconds;
}
/**
 * Pick the highest frame rate below `currentFps` whose estimated time (scaled by fps, with a safety margin for fixed costs) fits the remaining budget.
 * If none fits, use the lowest rate. Returns null if already at the lowest rate.
 */
export function nextFps({ currentFps, projectedMs, remainingMs, configuredFps = currentFps, margin = 1.3 }) {
  const lower = fpsLadder(configuredFps).filter((f) => f < currentFps);
  if (!lower.length) return null;
  return lower.find((f) => (projectedMs * f) / currentFps * margin <= remainingMs) ?? lower[lower.length - 1];
}
