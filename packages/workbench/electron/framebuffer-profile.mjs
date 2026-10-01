export const FRAMEBUFFER_PROFILES = Object.freeze({
  baseline: Object.freeze({ name: "baseline", width: 600, quality: 0.65 }),
  balanced: Object.freeze({ name: "balanced", width: 560, quality: 0.60 }),
  fast: Object.freeze({ name: "fast", width: 520, quality: 0.58 }),
  lean: Object.freeze({ name: "lean", width: 480, quality: 0.55 })
});

export const RUNTIME_FRAMEBUFFER_PROFILE = Object.freeze({
  ...FRAMEBUFFER_PROFILES.balanced,
  pollIntervalUs: 500
});

export const FRAMEBUFFER_PERFORMANCE_GATE = Object.freeze({
  profile: "balanced",
  maxRelativeP95: 0.90,
  maxRelativeBytes: 0.85,
  maxPsnrLossDb: 1.10
});