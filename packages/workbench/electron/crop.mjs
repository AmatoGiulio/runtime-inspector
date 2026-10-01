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
  const minWidth = Math.max(8, Math.floor(captureWidth * 0.68));
  const maxWidth = Math.min(captureWidth, Math.ceil(captureWidth * 0.99));

  const coarse = search({
    capture,
    captureWidth,
    captureHeight,
    reference,
    referenceWidth,
    referenceHeight,
    referenceAspect,
    minWidth,
    maxWidth,
    widthStep: 2,
    positionStep: 2,
    sampleXs: normalizedSamples(5, 0.1, 0.9),
    sampleYs: normalizedSamples(9, 0.16, 0.9)
  });

  if (!coarse) return undefined;

  const refined = search({
    capture,
    captureWidth,
    captureHeight,
    reference,
    referenceWidth,
    referenceHeight,
    referenceAspect,
    minWidth: Math.max(minWidth, coarse.width - 3),
    maxWidth: Math.min(maxWidth, coarse.width + 3),
    widthStep: 1,
    positionStep: 1,
    sampleXs: normalizedSamples(9, 0.08, 0.92),
    sampleYs: normalizedSamples(15, 0.16, 0.9),
    xRange: [Math.max(0, coarse.x - 4), Math.min(captureWidth - 1, coarse.x + 4)],
    yRange: [Math.max(0, coarse.y - 4), Math.min(captureHeight - 1, coarse.y + 4)]
  });

  const best = refined ?? coarse;
  if (best.score > 70) return undefined;

  return {
    x: best.x / captureWidth,
    y: best.y / captureHeight,
    width: best.width / captureWidth,
    height: best.height / captureHeight,
    score: best.score
  };
}

function search({
  capture,
  captureWidth,
  captureHeight,
  reference,
  referenceWidth,
  referenceHeight,
  referenceAspect,
  minWidth,
  maxWidth,
  widthStep,
  positionStep,
  sampleXs,
  sampleYs,
  xRange,
  yRange
}) {
  let best;

  for (let width = minWidth; width <= maxWidth; width += widthStep) {
    const height = Math.round(width / referenceAspect);
    if (height <= 0 || height > captureHeight) continue;

    const maxX = captureWidth - width;
    const maxY = captureHeight - height;
    const xStart = Math.min(maxX, Math.max(0, xRange?.[0] ?? 0));
    const xEnd = Math.min(maxX, xRange?.[1] ?? maxX);
    const yStart = Math.min(maxY, Math.max(0, yRange?.[0] ?? 0));
    const yEnd = Math.min(maxY, yRange?.[1] ?? maxY);

    for (let y = yStart; y <= yEnd; y += positionStep) {
      for (let x = xStart; x <= xEnd; x += positionStep) {
        const score = candidateScore({
          capture,
          captureWidth,
          reference,
          referenceWidth,
          referenceHeight,
          x,
          y,
          width,
          height,
          sampleXs,
          sampleYs
        });

        if (!best || score < best.score) {
          best = { x, y, width, height, score };
        }
      }
    }
  }

  return best;
}

function candidateScore({
  capture,
  captureWidth,
  reference,
  referenceWidth,
  referenceHeight,
  x,
  y,
  width,
  height,
  sampleXs,
  sampleYs
}) {
  let score = 0;
  let count = 0;

  for (const ny of sampleYs) {
    const referenceY = Math.min(
      referenceHeight - 1,
      Math.round(ny * (referenceHeight - 1))
    );
    const captureY = y + Math.round(ny * (height - 1));

    for (const nx of sampleXs) {
      const referenceX = Math.min(
        referenceWidth - 1,
        Math.round(nx * (referenceWidth - 1))
      );
      const captureX = x + Math.round(nx * (width - 1));

      score += pixelDistance(
        reference,
        (referenceY * referenceWidth + referenceX) * 4,
        capture,
        (captureY * captureWidth + captureX) * 4
      );
      count += 1;
    }
  }

  return score / Math.max(1, count);
}

function normalizedSamples(count, start, end) {
  if (count <= 1) return [(start + end) / 2];
  return Array.from(
    { length: count },
    (_, index) => start + ((end - start) * index) / (count - 1)
  );
}

function pixelDistance(a, ai, b, bi) {
  return (
    Math.abs(a[ai] - b[bi]) +
    Math.abs(a[ai + 1] - b[bi + 1]) +
    Math.abs(a[ai + 2] - b[bi + 2])
  ) / 3;
}
