import type { SpringValue } from "@runtime-inspector/protocol";

export interface SpringCurve {
  duration: number;
  points: Array<{ t: number; x: number }>;
}

const MIN_PARAM = 1e-3;
const MIN_DURATION = 0.25;
const MAX_DURATION = 4;
const SETTLING_CONSTANT = 6.9;
// Default sample count, per spec ("options.points ?? 120"); endpoints included.
const DEFAULT_POINTS = 120;

function safePositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : MIN_PARAM;
}

export function sampleSpringCurve(value: SpringValue, options?: { points?: number }): SpringCurve {
  const stiffness = safePositive(value.stiffness);
  const damping = safePositive(value.damping);
  const mass = safePositive(value.mass ?? 1);

  const omega0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const isCritical = Math.abs(zeta - 1) < 1e-6;
  const omegaH = !isCritical && zeta > 1 ? omega0 * Math.sqrt(zeta * zeta - 1) : 0;

  // Slowest-decaying pole: zeta*omega0 for underdamped, but for overdamped the
  // dominant decay is the slow pole zeta*omega0 - omegaH.
  const decayRate = isCritical ? omega0 : zeta < 1 ? zeta * omega0 : zeta * omega0 - omegaH;

  const rawDuration = SETTLING_CONSTANT / decayRate;
  const duration = Number.isFinite(rawDuration)
    ? Math.min(MAX_DURATION, Math.max(MIN_DURATION, rawDuration))
    : MAX_DURATION;

  const pointCount = Math.max(2, Math.round(options?.points ?? DEFAULT_POINTS));

  const responseAt = (t: number): number => {
    if (isCritical) {
      return 1 - Math.exp(-omega0 * t) * (1 + omega0 * t);
    }

    if (zeta < 1) {
      const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
      return (
        1 -
        Math.exp(-zeta * omega0 * t) *
          (Math.cos(omegaD * t) + ((zeta * omega0) / omegaD) * Math.sin(omegaD * t))
      );
    }

    // Overdamped: rewrite cosh/sinh combination as a sum of two decaying
    // exponentials so large t (typical range: damping 1-40, stiffness 20-400,
    // mass 0.2-4) never overflows via cosh/sinh individually.
    const r1 = zeta * omega0 + omegaH;
    const r2 = zeta * omega0 - omegaH;
    const a = (zeta * omega0 + omegaH) / (2 * omegaH);
    const b = (omegaH - zeta * omega0) / (2 * omegaH);
    return 1 - (a * Math.exp(-r2 * t) + b * Math.exp(-r1 * t));
  };

  const points: Array<{ t: number; x: number }> = [];
  for (let i = 0; i < pointCount; i += 1) {
    const t = (duration * i) / (pointCount - 1);
    const x = responseAt(t);
    points.push({ t, x: Number.isFinite(x) ? x : 1 });
  }

  return { duration, points };
}
