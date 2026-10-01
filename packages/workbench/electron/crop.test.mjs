import test from "node:test";
import assert from "node:assert/strict";
import { findNormalizedCrop } from "./crop.mjs";

function makeImage(width, height, pixel) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

test("findNormalizedCrop locates a scaled reference inside a larger window", () => {
  const referenceWidth = 40;
  const referenceHeight = 80;
  const reference = makeImage(referenceWidth, referenceHeight, (x, y) => [
    (x * 7 + y * 3) % 255,
    (x * 11 + y * 5) % 255,
    (x * 13 + y * 17) % 255
  ]);

  const captureWidth = 60;
  const captureHeight = 110;
  const cropX = 10;
  const cropY = 16;
  const cropWidth = 40;
  const cropHeight = 80;

  const capture = makeImage(captureWidth, captureHeight, () => [12, 12, 12]);

  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const sourceX = Math.round((x / (cropWidth - 1)) * (referenceWidth - 1));
      const sourceY = Math.round((y / (cropHeight - 1)) * (referenceHeight - 1));
      const si = (sourceY * referenceWidth + sourceX) * 4;
      const di = ((cropY + y) * captureWidth + cropX + x) * 4;
      capture[di] = reference[si];
      capture[di + 1] = reference[si + 1];
      capture[di + 2] = reference[si + 2];
      capture[di + 3] = 255;
    }
  }

  const result = findNormalizedCrop({
    capture,
    captureWidth,
    captureHeight,
    reference,
    referenceWidth,
    referenceHeight
  });

  assert.ok(result);
  assert.ok(Math.abs(result.x - cropX / captureWidth) < 0.03);
  assert.ok(Math.abs(result.y - cropY / captureHeight) < 0.03);
  assert.ok(Math.abs(result.width - cropWidth / captureWidth) < 0.03);
  assert.ok(Math.abs(result.height - cropHeight / captureHeight) < 0.03);
});

test("findNormalizedCrop prefers the framebuffer over a similarly shaped dark bezel", () => {
  const referenceWidth = 60;
  const referenceHeight = 130;
  const reference = makeImage(referenceWidth, referenceHeight, (x, y) => {
    // Mostly dark app, deliberately similar to a black device frame.
    let r = 22;
    let g = 24;
    let b = 29;

    // Status bar / Dynamic Island landmarks.
    if (y < 12 && x > 20 && x < 40) return [0, 0, 0];
    if (y < 10 && x < 15) return [230, 230, 230];

    // Bright app card.
    if (y > 52 && y < 88 && x > 6 && x < 54) return [244, 246, 250];

    // Tap-test outline/text region.
    if (y > 94 && y < 112 && x > 7 && x < 53) return [48, 51, 61];
    if (y > 99 && y < 103 && x > 22 && x < 38) return [240, 240, 244];

    return [r, g, b];
  });

  const captureWidth = 84;
  const captureHeight = 166;
  const screenX = 12;
  const screenY = 18;
  const screenWidth = 60;
  const screenHeight = 130;

  // Dark outer "device" frame with almost the same aspect ratio.
  const capture = makeImage(captureWidth, captureHeight, () => [8, 8, 9]);

  for (let y = 0; y < screenHeight; y += 1) {
    for (let x = 0; x < screenWidth; x += 1) {
      const si = (y * referenceWidth + x) * 4;
      const di = ((screenY + y) * captureWidth + screenX + x) * 4;
      capture[di] = reference[si];
      capture[di + 1] = reference[si + 1];
      capture[di + 2] = reference[si + 2];
      capture[di + 3] = 255;
    }
  }

  const result = findNormalizedCrop({
    capture,
    captureWidth,
    captureHeight,
    reference,
    referenceWidth,
    referenceHeight
  });

  assert.ok(result);
  assert.ok(Math.abs(result.x - screenX / captureWidth) < 0.025);
  assert.ok(Math.abs(result.y - screenY / captureHeight) < 0.025);
  assert.ok(Math.abs(result.width - screenWidth / captureWidth) < 0.025);
  assert.ok(Math.abs(result.height - screenHeight / captureHeight) < 0.025);
});
