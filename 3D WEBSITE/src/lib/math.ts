/** Small pure helpers shared by the scroll rig and every 3D object. */

export function clamp(value: number, min = 0, max = 1): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(current: number, target: number, factor: number): number {
  return current + (target - current) * factor;
}

/** Smooth 0->1 easing with zero velocity at both ends (Hermite). */
export function smoothstep(t: number): number {
  const x = clamp(t);
  return x * x * (3 - 2 * x);
}

/** Re-map `value` from one range to another, clamped to the output range. */
export function mapRange(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  if (inMax === inMin) return outMin;
  const t = clamp((value - inMin) / (inMax - inMin));
  return outMin + t * (outMax - outMin);
}

/**
 * A section's own 0->1 progress, eased. Each 3D object owns a scroll window and
 * animates inside it, so entrances and exits ease instead of snapping.
 */
export function windowProgress(progress: number, enter: number, exit: number): number {
  return smoothstep(mapRange(progress, enter, exit, 0, 1));
}
