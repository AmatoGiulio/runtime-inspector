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
  const minWidth = Math.max(8, Math.floor(captureWidth * 0.62));
  const maxWidth = Math.min(captureWidth, Math.ceil(captureWidth * 0.98));

  // Fixed grids were too easily fooled by the mostly-dark Simulator bezel:
  // a slightly oversized crop could still look "close" at many samples.
  // Instead, select high-gradient reference points (status icons, Dynamic
  // Island, text/card/button edges) distributed over the whole framebuffer.
  const features = buildFeatureSamples(reference, referenceWidth, referenceHeight, 8, 14);
  if (features.length < 12) return undefined;

  const coarseFeatures = features.filter((_, index) => index % 2 === 0);

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
    features: coarseFeatures
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
    minWidth: Math.max(minWidth, coarse.width - 4),
    maxWidth: Math.min(maxWidth, coarse.width + 4),
    widthStep: 1,
    positionStep: 1,
    features,
    xRange: [Math.max(0, coarse.x - 5), Math.min(captureWidth - 1, coarse.x + 5)],
    yRange: [Math.max(0, coarse.y - 5), Math.min(captureHeight - 1, coarse.y + 5)]
  });

  const best = refined ?? coarse;
  if (best.score > 72) return undefined;

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
  features,
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
          features
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
  features
}) {
  let score = 0;
  let totalWeight = 0;

  for (const feature of features) {
    const referenceX = Math.min(
      referenceWidth - 1,
      Math.round(feature.nx * (referenceWidth - 1))
    );
    const referenceY = Math.min(
      referenceHeight - 1,
      Math.round(feature.ny * (referenceHeight - 1))
    );
    const captureX = x + Math.round(feature.nx * (width - 1));
    const captureY = y + Math.round(feature.ny * (height - 1));
    const weight = feature.weight;

    score +=
      pixelDistance(
        reference,
        (referenceY * referenceWidth + referenceX) * 4,
        capture,
        (captureY * captureWidth + captureX) * 4
      ) * weight;
    totalWeight += weight;
  }

  return score / Math.max(1, totalWeight);
}

function buildFeatureSamples(data, width, height, columns, rows) {
  const result = [];

  for (let row = 0; row < rows; row += 1) {
    const y0 = Math.max(1, Math.floor((row / rows) * height));
    const y1 = Math.min(height - 2, Math.ceil(((row + 1) / rows) * height));

    for (let column = 0; column < columns; column += 1) {
      const x0 = Math.max(1, Math.floor((column / columns) * width));
      const x1 = Math.min(width - 2, Math.ceil(((column + 1) / columns) * width));

      let strongest;

      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const center = (y * width + x) * 4;
          const left = center - 4;
          const right = center + 4;
          const up = center - width * 4;
          const down = center + width * 4;

          const gradient =
            pixelDistance(data, left, data, right) +
            pixelDistance(data, up, data, down);

          if (!strongest || gradient > strongest.gradient) {
            strongest = { x, y, gradient };
          }
        }
      }

      if (strongest && strongest.gradient >= 8) {
        result.push({
          nx: strongest.x / (width - 1),
          ny: strongest.y / (height - 1),
          // Strong edges carry more information, but cap the weight so a
          // single white-card edge cannot dominate the complete screen.
          weight: Math.min(4, Math.max(1, strongest.gradient / 24)),
          gradient: strongest.gradient
        });
      }
    }
  }

  return result.sort((a, b) => b.gradient - a.gradient);
}

function pixelDistance(a, ai, b, bi) {
  return (
    Math.abs(a[ai] - b[bi]) +
    Math.abs(a[ai + 1] - b[bi + 1]) +
    Math.abs(a[ai + 2] - b[bi + 2])
  ) / 3;
}
