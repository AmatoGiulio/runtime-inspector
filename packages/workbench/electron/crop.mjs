export function findNormalizedCrop({
  capture,
  captureWidth,
  captureHeight,
  reference,
  referenceWidth,
  referenceHeight
}) {
  if (
    !capture ||
    !reference ||
    captureWidth < 8 ||
    captureHeight < 8 ||
    referenceWidth < 8 ||
    referenceHeight < 8
  ) {
    return undefined;
  }

  const referenceAspect = referenceWidth / referenceHeight;
  let best;

  const minWidth = Math.max(8, Math.floor(captureWidth * 0.7));
  const maxWidth = Math.min(captureWidth, Math.ceil(captureWidth * 0.99));

  // Ignore the dynamic-island/status-bar edge and home-indicator edge. The app
  // body is much more stable for one-shot template matching.
  const sampleXs = normalizedSamples(9, 0.08, 0.92);
  const sampleYs = normalizedSamples(15, 0.16, 0.9);

  for (let width = minWidth; width <= maxWidth; width += 1) {
    const height = Math.round(width / referenceAspect);
    if (height <= 0 || height > captureHeight) continue;

    const maxX = captureWidth - width;
    const maxY = captureHeight - height;

    for (let y = 0; y <= maxY; y += 1) {
      for (let x = 0; x <= maxX; x += 1) {
        let score = 0;
        let count = 0;

        for (const ny of sampleYs) {
          const referenceY = Math.min(
            referenceHeight - 1,
            Math.round(ny * (referenceHeight - 1))
          );
          const captureY = Math.min(
            captureHeight - 1,
            y + Math.round(ny * (height - 1))
          );

          for (const nx of sampleXs) {
            const referenceX = Math.min(
              referenceWidth - 1,
              Math.round(nx * (referenceWidth - 1))
            );
            const captureX = Math.min(
              captureWidth - 1,
              x + Math.round(nx * (width - 1))
            );

            score += pixelDistance(
              reference,
              (referenceY * referenceWidth + referenceX) * 4,
              capture,
              (captureY * captureWidth + captureX) * 4
            );
            count += 1;
          }
        }

        const average = score / Math.max(1, count);
        if (!best || average < best.score) {
          best = { x, y, width, height, score: average };
        }
      }
    }
  }

  if (!best) return undefined;

  // Exact screenshots normally land well below this. A permissive threshold
  // keeps the fallback useful across color-management/scaling differences,
  // while refusing obviously unrelated window content.
  if (best.score > 70) return undefined;

  return {
    x: best.x / captureWidth,
    y: best.y / captureHeight,
    width: best.width / captureWidth,
    height: best.height / captureHeight,
    score: best.score
  };
}

function normalizedSamples(count, start, end) {
  if (count <= 1) return [(start + end) / 2];
  return Array.from({ length: count }, (_, index) => start + ((end - start) * index) / (count - 1));
}

function pixelDistance(a, ai, b, bi) {
  // NativeImage bitmaps are platform-native channel order; summing absolute
  // distance across the first three channels is order-invariant because both
  // images come from the same NativeImage conversion path.
  return (
    Math.abs(a[ai] - b[bi]) +
    Math.abs(a[ai + 1] - b[bi + 1]) +
    Math.abs(a[ai + 2] - b[bi + 2])
  ) / 3;
}
