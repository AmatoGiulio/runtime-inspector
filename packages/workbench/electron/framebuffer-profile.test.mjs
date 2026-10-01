import test from "node:test";
import assert from "node:assert/strict";
import {
  FRAMEBUFFER_PERFORMANCE_GATE,
  FRAMEBUFFER_PROFILES,
  RUNTIME_FRAMEBUFFER_PROFILE
} from "./framebuffer-profile.mjs";

test("balanced framebuffer profile is the official runtime profile", () => {
  assert.deepEqual(
    {
      name: RUNTIME_FRAMEBUFFER_PROFILE.name,
      width: RUNTIME_FRAMEBUFFER_PROFILE.width,
      quality: RUNTIME_FRAMEBUFFER_PROFILE.quality
    },
    FRAMEBUFFER_PROFILES.balanced
  );

  assert.equal(RUNTIME_FRAMEBUFFER_PROFILE.pollIntervalUs, 500);
});

test("official framebuffer gate protects speed, payload, and quality", () => {
  assert.deepEqual(FRAMEBUFFER_PERFORMANCE_GATE, {
    profile: "balanced",
    maxRelativeP95: 0.90,
    maxRelativeBytes: 0.85,
    maxPsnrLossDb: 1.10
  });
});