export function computeScore({ correct, timeMs, timeLimitMs, mode = "speed" }) {
  if (!correct) return 0;

  if (mode === "standard") return 1000;

  if (mode === "double") {
    const base = computeScore({ correct, timeMs, timeLimitMs, mode: "speed" });
    return base * 2;
  }

  const clamped = Math.min(Math.max(timeMs, 0), timeLimitMs);
  const speedRatio = 1 - clamped / timeLimitMs;
  const points = 500 + Math.round(500 * speedRatio);
  return points;
}

export function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
