/* Extra paper candidates for uneven A4/A3 outlines. Shared by the UI and scan Worker. */
(function (root) {
  'use strict';

  function orderCorners(points) {
    const center = points.reduce((sum, p) => ({ x: sum.x + p.x / 4, y: sum.y + p.y / 4 }), { x: 0, y: 0 });
    const ordered = points.slice().sort((a, b) =>
      Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
    let first = 0;
    ordered.forEach((p, i) => { if (p.x + p.y < ordered[first].x + ordered[first].y) first = i; });
    return ordered.map((_, i) => ordered[(first + i) % 4]);
  }

  function polygonArea(points) {
    return Math.abs(points.reduce((sum, p, i) => {
      const next = points[(i + 1) % points.length];
      return sum + p.x * next.y - next.x * p.y;
    }, 0)) / 2;
  }

  function pointsFromMat(mat) {
    const points = [];
    for (let i = 0; i < mat.rows; i++) points.push({ x: mat.data32S[i * 2], y: mat.data32S[i * 2 + 1] });
    return points;
  }

  function hueOf(red, green, blue) {
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const range = maximum - minimum;
    if (!range) return 0;
    let hue = maximum === red ? (green - blue) / range
      : maximum === green ? 2 + (blue - red) / range
      : 4 + (red - green) / range;
    hue /= 6;
    return hue < 0 ? hue + 1 : hue;
  }

  function hueDistance(first, second) {
    const distance = Math.abs(first - second);
    return Math.min(distance, 1 - distance);
  }

  // Estimate a coloured support surface from thin image-border samples. This is
  // useful for mixed-colour documents (for example a white page beside a red
  // cover), where a brightness-only paper mask can retain just one half.
  function fillBackgroundContrastMask(source, mask) {
    if (!source || !source.data || !mask || !mask.data) return false;
    const width = source.cols;
    const height = source.rows;
    const pixels = source.data;
    const bins = new Uint32Array(24);
    const saturationSums = new Float64Array(24);
    const border = Math.max(2, Math.round(Math.min(width, height) * 0.025));
    let samples = 0;
    // Include a sparse sample of the whole frame because real field photos can
    // have people, floor or equipment along every image edge. Border pixels
    // still receive more weight, while the interior lets the actual support
    // colour win when those edge samples are contaminated.
    for (let y = 0; y < height; y += 3) {
      for (let x = 0; x < width; x += 3) {
        const onBorder = x < border || x >= width - border || y < border || y >= height - border;
        const weight = onBorder ? 3 : 1;
        const offset = (y * width + x) * 4;
        const red = pixels[offset] / 255;
        const green = pixels[offset + 1] / 255;
        const blue = pixels[offset + 2] / 255;
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        const saturation = maximum ? (maximum - minimum) / maximum : 0;
        if (saturation < 0.22 || maximum < 0.12) continue;
        const bin = Math.min(23, Math.floor(hueOf(red, green, blue) * 24));
        bins[bin] += weight;
        saturationSums[bin] += saturation * weight;
        samples += weight;
      }
    }
    let dominant = 0;
    for (let index = 1; index < bins.length; index++) if (bins[index] > bins[dominant]) dominant = index;
    if (samples < 40 || bins[dominant] < samples * 0.16) return false;
    const backgroundHue = (dominant + 0.5) / bins.length;
    const backgroundSaturation = saturationSums[dominant] / bins[dominant];
    const bits = mask.data;
    for (let index = 0, offset = 0; index < bits.length; index++, offset += 4) {
      const red = pixels[offset] / 255;
      const green = pixels[offset + 1] / 255;
      const blue = pixels[offset + 2] / 255;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const saturation = maximum ? (maximum - minimum) / maximum : 0;
      const sameSurface = saturation >= Math.max(0.12, backgroundSaturation * 0.30) &&
        hueDistance(hueOf(red, green, blue), backgroundHue) <= 0.14;
      bits[index] = sameSurface ? 0 : 255;
    }
    return true;
  }

  // Build a conservative document mask from the image border. This covers
  // neutral tables and faded paper where hue-based separation is unavailable.
  // It is intentionally only a candidate generator; fitOutline still applies
  // the area, solidity, edge and aspect-ratio checks before accepting it.
  function fillBorderContrastMask(source, mask) {
    if (!source || !source.data || !mask || !mask.data) return false;
    const width = source.cols;
    const height = source.rows;
    const pixels = source.data;
    // Sample the four corners independently, not the full image border: on
    // open certificates the paper itself often touches most of that border.
    // A bilinear support-colour model also follows broad floor shadows.
    const patch = Math.max(4, Math.round(Math.min(width, height) * 0.04));
    const cornerColors = [[0, 0], [width - patch, 0], [0, height - patch], [width - patch, height - patch]].map(([left, top]) => {
      const channels = [[], [], []];
      for (let y = top; y < Math.min(height, top + patch); y += 2) {
        for (let x = left; x < Math.min(width, left + patch); x += 2) {
          const offset = (y * width + x) * 4;
          for (let channel = 0; channel < 3; channel++) channels[channel].push(pixels[offset + channel]);
        }
      }
      return channels.map(values => {
        values.sort((first, second) => first - second);
        return values[Math.floor(values.length * 0.5)] || 0;
      });
    });
    const threshold = 38;
    let foreground = 0;
    for (let index = 0, offset = 0; index < mask.data.length; index++, offset += 4) {
      const x = index % width, y = Math.floor(index / width);
      const horizontal = x / Math.max(1, width - 1), vertical = y / Math.max(1, height - 1);
      const expected = [0, 1, 2].map(channel => {
        const top = cornerColors[0][channel] * (1 - horizontal) + cornerColors[1][channel] * horizontal;
        const bottom = cornerColors[2][channel] * (1 - horizontal) + cornerColors[3][channel] * horizontal;
        return top * (1 - vertical) + bottom * vertical;
      });
      const distance = Math.hypot(pixels[offset] - expected[0], pixels[offset + 1] - expected[1], pixels[offset + 2] - expected[2]);
      const keep = distance >= threshold;
      mask.data[index] = keep ? 255 : 0;
      if (keep) foreground++;
    }
    return foreground >= mask.data.length * 0.055 && foreground <= mask.data.length * 0.88;
  }

  // Recover the missing half of an open certificate when the regular contour
  // detector locks onto only one page. It samples a narrow, low-resolution
  // raster and extends the detected page only across columns that consistently
  // differ from the dominant coloured support surface.
  function recoverSpread(sourceCanvas, page) {
    if (!sourceCanvas || !page || !page.corners || page.corners.length !== 4) return null;
    const sourceWidth = sourceCanvas.width, sourceHeight = sourceCanvas.height;
    if (!sourceWidth || !sourceHeight) return null;
    const pageCenter = page.x + page.width / 2;
    const missingLeft = pageCenter > sourceWidth * 0.60;
    const missingRight = pageCenter < sourceWidth * 0.40;
    if (!missingLeft && !missingRight) return null;

    const scale = Math.min(1, 320 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    let probe;
    if (sourceCanvas.getContext) probe = sourceCanvas;
    else if (typeof OffscreenCanvas !== 'undefined') {
      probe = new OffscreenCanvas(width, height);
      probe.getContext('2d').drawImage(sourceCanvas, 0, 0, width, height);
    } else if (typeof document !== 'undefined') {
      probe = document.createElement('canvas'); probe.width = width; probe.height = height;
      probe.getContext('2d').drawImage(sourceCanvas, 0, 0, width, height);
    } else return null;
    if (probe === sourceCanvas && scale < 1) {
      const resized = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
      resized.width = width; resized.height = height;
      resized.getContext('2d').drawImage(sourceCanvas, 0, 0, width, height); probe = resized;
    }
    const pixels = probe.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    const px = page.x * scale, py = page.y * scale, pw = page.width * scale, ph = page.height * scale;
    const bins = new Uint32Array(24), borderBins = new Uint32Array(24), saturationSums = new Float64Array(24);
    const borderBand = Math.max(2, Math.round(Math.min(width, height) * 0.04));
    let samples = 0;
    for (let y = 0; y < height; y += 3) for (let x = 0; x < width; x += 3) {
      if (x >= px && x <= px + pw && y >= py && y <= py + ph) continue;
      const offset = (y * width + x) * 4;
      const red = pixels[offset] / 255, green = pixels[offset + 1] / 255, blue = pixels[offset + 2] / 255;
      const maximum = Math.max(red, green, blue), minimum = Math.min(red, green, blue);
      const saturation = maximum ? (maximum - minimum) / maximum : 0;
      if (saturation < 0.25 || maximum < 0.12) continue;
      const bin = Math.min(23, Math.floor(hueOf(red, green, blue) * 24));
      bins[bin]++; saturationSums[bin] += saturation; samples++;
      if (x < borderBand || x >= width - borderBand || y < borderBand || y >= height - borderBand) borderBins[bin]++;
    }
    let dominant = 0;
    for (let index = 1; index < bins.length; index++) if (bins[index] > bins[dominant]) dominant = index;
    const dominantSaturation = bins[dominant] ? saturationSums[dominant] / bins[dominant] : 0;
    const hasColourSupport = samples >= 50 && bins[dominant] >= samples * 0.18 &&
      borderBins[dominant] >= 10 && dominantSaturation >= 0.40;
    const backgroundHue = hasColourSupport ? (dominant + 0.5) / bins.length : 0;
    const backgroundSaturation = hasColourSupport ? dominantSaturation : 0;
    const top = Math.max(0, Math.floor(py + ph * 0.08));
    const bottom = Math.min(height - 1, Math.ceil(py + ph * 0.92));
    const requiredHits = Math.max(3, Math.round((bottom - top + 1) * 0.58));
    const hits = new Uint16Array(width);
    for (let y = top; y <= bottom; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const red = pixels[offset] / 255, green = pixels[offset + 1] / 255, blue = pixels[offset + 2] / 255;
      const maximum = Math.max(red, green, blue), minimum = Math.min(red, green, blue);
      const saturation = maximum ? (maximum - minimum) / maximum : 0;
      const support = hasColourSupport && saturation >= Math.max(0.12, backgroundSaturation * 0.30) &&
        hueDistance(hueOf(red, green, blue), backgroundHue) <= 0.14;
      if (hasColourSupport && !support) hits[x]++;
    }
    if (!hasColourSupport) {
      // Neutral granite/tile has no stable hue. Compare narrow strips on both
      // sides of the top and bottom page edges independently. Keeping the two
      // edge comparisons separate avoids treating two different floor tiles as
      // one large sheet of paper.
      function range(from, to) {
        return [Math.max(0, Math.min(height - 1, Math.floor(py + ph * from))),
          Math.max(0, Math.min(height - 1, Math.ceil(py + ph * to)))];
      }
      const topInside = range(0.05, 0.18), topOutside = range(-0.18, -0.05);
      const bottomInside = range(0.82, 0.95), bottomOutside = range(1.05, 1.18);
      function columnMean(x, sampleRange) {
        let red = 0, green = 0, blue = 0, count = 0;
        const ranges = [sampleRange];
        ranges.forEach(range => {
          for (let y = range[0]; y <= range[1]; y += 2) {
            const offset = (y * width + x) * 4;
            const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
            red += r; green += g; blue += b; count++;
          }
        });
        if (!count) return null;
        return { red: red / count, green: green / count, blue: blue / count };
      }
      function colourDistance(first, second) {
        return first && second ? Math.hypot(first.red - second.red, first.green - second.green, first.blue - second.blue) : 0;
      }
      for (let x = 0; x < width; x++) {
        const topDifference = colourDistance(columnMean(x, topInside), columnMean(x, topOutside));
        const bottomDifference = colourDistance(columnMean(x, bottomInside), columnMean(x, bottomOutside));
        if ((topDifference >= 14 && bottomDifference >= 14) || topDifference >= 38 || bottomDifference >= 38) {
          hits[x] = requiredHits;
        }
      }
    }
    let edge = missingLeft ? Math.max(0, Math.floor(px)) : Math.min(width - 1, Math.ceil(px + pw));
    let gap = 0, boundary = edge;
    let usedFrameEstimate = false;
    if (missingLeft) for (let x = edge - 1; x >= 0; x--) {
      if (hits[x] >= requiredHits) { boundary = x; gap = 0; }
      else if (++gap > 3) break;
    } else for (let x = edge + 1; x < width; x++) {
      if (hits[x] >= requiredHits) { boundary = x; gap = 0; }
      else if (++gap > 3) break;
    }
    edge = boundary;
    let recoveredX = edge / scale;
    let recoveredWidth = missingLeft ? page.x + page.width - recoveredX : recoveredX - page.x;
    if (recoveredWidth < page.width * 1.45 || recoveredWidth < sourceWidth * 0.60) {
      // When the support and the faded certificate have nearly identical
      // colours, no column can be classified reliably. The sample photos are
      // nevertheless a clear open spread: one tall page occupies most of the
      // frame and the missing half runs toward the opposite frame edge. Use a
      // guarded frame-boundary estimate, retaining the perspective of the
      // detected half instead of discarding the document entirely.
      const pageAreaRatio = (page.width * page.height) / (sourceWidth * sourceHeight);
      if (pageAreaRatio < 0.08 || page.height < sourceHeight * 0.28) return null;
      // For a centrally framed open certificate, continue the missing half by
      // one detected page-width. Do not jump to a fixed image margin: the
      // table/floor around the document can be much larger than the document.
      recoveredX = missingLeft ? page.x - page.width : page.x + page.width * 2;
      recoveredWidth = missingLeft ? page.x + page.width - recoveredX : recoveredX - page.x;
      if (recoveredWidth < page.width * 1.45 || recoveredWidth < sourceWidth * 0.30 ||
          recoveredX < 0 || recoveredX >= sourceWidth) return null;
    }
    const corners = page.corners;
    function lineY(first, second, x) {
      return first.y + (second.y - first.y) * (x - first.x) / Math.max(1, second.x - first.x);
    }
    const frameTop = Math.max(0, Math.floor(page.y - sourceHeight * 0.08));
    const frameBottom = Math.min(sourceHeight, Math.ceil(page.y + page.height + sourceHeight * 0.08));
    const expanded = usedFrameEstimate
      ? (missingLeft
        ? [{ x: recoveredX, y: frameTop }, { x: page.x + page.width, y: frameTop },
          { x: page.x + page.width, y: frameBottom }, { x: recoveredX, y: frameBottom }]
        : [{ x: page.x, y: frameTop }, { x: recoveredX, y: frameTop },
          { x: recoveredX, y: frameBottom }, { x: page.x, y: frameBottom }])
      : (missingLeft
        ? [{ x: recoveredX, y: lineY(corners[0], corners[1], recoveredX) }, corners[1], corners[2],
          { x: recoveredX, y: lineY(corners[3], corners[2], recoveredX) }]
        : [corners[0], { x: recoveredX, y: lineY(corners[0], corners[1], recoveredX) },
          { x: recoveredX, y: lineY(corners[3], corners[2], recoveredX) }, corners[3]]);
    const xs = expanded.map(point => point.x), ys = expanded.map(point => point.y);
    const x = Math.max(0, Math.floor(Math.min(...xs))), y = Math.max(0, Math.floor(Math.min(...ys)));
    const right = Math.min(sourceWidth, Math.ceil(Math.max(...xs))), bottomEdge = Math.min(sourceHeight, Math.ceil(Math.max(...ys)));
    return { x, y, width: right - x, height: bottomEdge - y, corners: expanded, detected: true,
      method: 'opencv', paperShape: true, paperConfidence: 0.82, detectionVariant: 'spread-support' };
  }

  // Expand the fitted quad to contain the whole hull, including curled edges.
  function encloseOutline(corners, outline, width, height, maximumExpansion, clampToFrame) {
    const center = corners.reduce((sum, p) => ({ x: sum.x + p.x / 4, y: sum.y + p.y / 4 }), { x: 0, y: 0 });
    let expansion = 1;
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      const nx = b.y - a.y, ny = a.x - b.x;
      const radius = nx * (a.x - center.x) + ny * (a.y - center.y);
      if (radius <= 0) return null;
      for (const p of outline) expansion = Math.max(expansion, (nx * (p.x - center.x) + ny * (p.y - center.y)) / radius);
    }
    // A large expansion means four corners do not describe this component well.
    if (expansion > (maximumExpansion || 1.08)) return null;
    expansion += 0.008;
    let padded = corners.map(p => ({ x: center.x + (p.x - center.x) * expansion, y: center.y + (p.y - center.y) * expansion }));
    if (padded.some(p => p.x < 0 || p.y < 0 || p.x >= width || p.y >= height)) {
      if (!clampToFrame) return null;
      padded = padded.map(p => ({ x: Math.max(0, Math.min(width - 1, p.x)), y: Math.max(0, Math.min(height - 1, p.y)) }));
    }
    return padded;
  }

  function fitOutline(cv, contour, width, height, sourceCanvas, scale, damagedPaper) {
    const contourArea = Math.abs(cv.contourArea(contour));
    if (contourArea < width * height * 0.055 || contourArea > width * height * 0.88) return null;
    const hull = new cv.Mat();
    const polygon = new cv.Mat();
    try {
      cv.convexHull(contour, hull, false, true);
      const hullArea = Math.abs(cv.contourArea(hull));
      const solidity = hullArea ? contourArea / hullArea : 0;
      if (!hullArea || solidity < (damagedPaper ? 0.66 : 0.78)) return null;
      const outline = pointsFromMat(hull);
      const margin = Math.max(2, Math.min(width, height) * 0.006);
      const touchedEdges = [
        outline.some(p => p.x <= margin), outline.some(p => p.y <= margin),
        outline.some(p => p.x >= width - margin), outline.some(p => p.y >= height - margin)
      ].filter(Boolean).length;
      if ((!damagedPaper && touchedEdges) || (damagedPaper && touchedEdges > 1)) return null;

      let corners = null;
      const perimeter = cv.arcLength(hull, true);
      for (const epsilon of [0.012, 0.02, 0.035, 0.05, 0.075]) {
        cv.approxPolyDP(hull, polygon, epsilon * perimeter, true);
        if (polygon.rows !== 4 || !cv.isContourConvex(polygon)) continue;
        corners = encloseOutline(orderCorners(pointsFromMat(polygon)), outline, width, height,
          damagedPaper ? 1.14 : 1.08, damagedPaper && touchedEdges === 1);
        if (corners) break;
      }
      if (!corners) {
        // Strongly curved edges can retain more than four vertices at every epsilon.
        const rect = cv.minAreaRect(hull);
        const angle = rect.angle * Math.PI / 180;
        const cosine = Math.cos(angle), sine = Math.sin(angle);
        corners = orderCorners([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => ({
          x: rect.center.x + x * rect.size.width * cosine / 2 - y * rect.size.height * sine / 2,
          y: rect.center.y + x * rect.size.width * sine / 2 + y * rect.size.height * cosine / 2
        })));
        corners = encloseOutline(corners, outline, width, height,
          damagedPaper ? 1.14 : 1.08, damagedPaper && touchedEdges === 1);
      }
      if (!corners) return null;
      const area = polygonArea(corners);
      const fill = contourArea / area;
      if (fill < (damagedPaper ? 0.68 : 0.76) || area > width * height * 0.9) return null;
      const sides = corners.map((p, i) => Math.hypot(p.x - corners[(i + 1) % 4].x, p.y - corners[(i + 1) % 4].y));
      const paperWidth = (sides[0] + sides[2]) / 2;
      const paperHeight = (sides[1] + sides[3]) / 2;
      const aspect = Math.max(paperWidth, paperHeight) / Math.max(1, Math.min(paperWidth, paperHeight));
      if (aspect < 1.12 || aspect > 1.95 || Math.max(sides[0], sides[2]) / Math.max(1, Math.min(sides[0], sides[2])) > 1.6 ||
          Math.max(sides[1], sides[3]) / Math.max(1, Math.min(sides[1], sides[3])) > 1.6) return null;
      const scaled = corners.map(p => ({ x: p.x / scale, y: p.y / scale }));
      const x = Math.max(0, Math.floor(Math.min(...scaled.map(p => p.x))));
      const y = Math.max(0, Math.floor(Math.min(...scaled.map(p => p.y))));
      const right = Math.min(sourceCanvas.width, Math.ceil(Math.max(...scaled.map(p => p.x))));
      const bottom = Math.min(sourceCanvas.height, Math.ceil(Math.max(...scaled.map(p => p.y))));
      return { x, y, width: right - x, height: bottom - y, corners: scaled, detected: true,
        method: 'opencv', paperShape: true,
        paperConfidence: Math.min(fill, solidity) * Math.exp(-Math.abs(Math.log(aspect / Math.SQRT2))) };
    } finally {
      hull.delete();
      polygon.delete();
    }
  }

  // Dedicated outer-quad recovery for open certificates over a low-contrast
  // support. The regular A4/A3 candidate rules stay unchanged; this candidate
  // is considered only for spread scans after those rules have run.
  function refineSpreadBottomEdge(sourceCanvas, corners) {
    if (!sourceCanvas || !corners || corners.length !== 4) return null;
    let probe = null;
    try {
      const scale = Math.min(1, 1000 / Math.max(sourceCanvas.width, sourceCanvas.height));
      const width = Math.max(1, Math.round(sourceCanvas.width * scale));
      const height = Math.max(1, Math.round(sourceCanvas.height * scale));
      probe = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : (typeof document !== 'undefined' ? document.createElement('canvas') : null);
      if (!probe) return null;
      probe.width = width; probe.height = height;
      const context = probe.getContext('2d', { willReadFrequently: true });
      context.drawImage(sourceCanvas, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      const scaled = corners.map(point => ({ x: point.x * scale, y: point.y * scale }));
      const left = Math.max(0, Math.floor(Math.min(scaled[0].x, scaled[1].x) - width * 0.10));
      const right = Math.min(width - 1, Math.ceil(Math.max(scaled[0].x, scaled[1].x) + width * 0.10));
      const estimatedBottom = (scaled[2].y + scaled[3].y) / 2;
      const searchTop = Math.max(Math.floor(height * 0.58), Math.floor(estimatedBottom - height * 0.10));
      const searchBottom = Math.min(height - 2, Math.ceil(estimatedBottom + height * 0.07));
      let bestY = -1, bestScore = 0;
      for (let y = searchTop; y <= searchBottom; y++) {
        let score = 0, samples = 0;
        for (let x = left; x <= right; x += 3) {
          const first = (y * width + x) * 4, second = first + width * 4;
          score += Math.abs(pixels[first] - pixels[second]) +
            Math.abs(pixels[first + 1] - pixels[second + 1]) +
            Math.abs(pixels[first + 2] - pixels[second + 2]);
          samples++;
        }
        const average = score / Math.max(1, samples);
        if (average > bestScore) { bestScore = average; bestY = y; }
      }
      // Require a coherent cross-page edge; texture and text tend to be less
      // consistent across this broad horizontal span.
      if (bestY < 0 || bestScore < 7) return null;
      const edgeThreshold = Math.max(22, bestScore * 1.45);
      const points = [];
      for (let x = left; x <= right; x++) {
        let strength = 0, edgeY = bestY;
        for (let y = Math.max(0, bestY - 5); y <= Math.min(height - 2, bestY + 5); y++) {
          const first = (y * width + x) * 4, second = first + width * 4;
          const difference = Math.abs(pixels[first] - pixels[second]) +
            Math.abs(pixels[first + 1] - pixels[second + 1]) +
            Math.abs(pixels[first + 2] - pixels[second + 2]);
          if (difference > strength) { strength = difference; edgeY = y; }
        }
        if (strength >= edgeThreshold) points.push({ x, y: edgeY });
      }
      if (points.length < (right - left) * 0.42) return null;
      const gapLimit = Math.max(3, width * 0.025);
      let runStart = 0, runEnd = 0, currentStart = 0;
      for (let index = 1; index <= points.length; index++) {
        if (index === points.length || points[index].x - points[index - 1].x > gapLimit) {
          if (points[index - 1].x - points[currentStart].x > runEnd - runStart) {
            runStart = points[currentStart].x; runEnd = points[index - 1].x;
          }
          currentStart = index;
        }
      }
      const run = points.filter(point => point.x >= runStart && point.x <= runEnd);
      if (runEnd - runStart < (scaled[1].x - scaled[0].x) * 0.62 || run.length < 12) return null;
      const meanX = run.reduce((sum, point) => sum + point.x, 0) / run.length;
      const meanY = run.reduce((sum, point) => sum + point.y, 0) / run.length;
      const slope = run.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) /
        Math.max(1, run.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0));
      const intercept = meanY - slope * meanX;
      const refined = [scaled[0], scaled[1],
        { x: runEnd, y: slope * runEnd + intercept },
        { x: runStart, y: slope * runStart + intercept }];
      return refined.map(point => ({ x: point.x / scale, y: point.y / scale }));
    } catch (_) {
      return null;
    }
  }

  // The regular contour fit can be pulled outward by a faint floor seam at
  // the top of an old certificate. Refine only that edge when a long, coherent
  // image edge is present; keep its already-good side and bottom corners.
  function refineSpreadTopEdge(sourceCanvas, corners) {
    if (!sourceCanvas || !corners || corners.length !== 4) return null;
    try {
      const scale = Math.min(1, 1000 / Math.max(sourceCanvas.width, sourceCanvas.height));
      const width = Math.max(1, Math.round(sourceCanvas.width * scale));
      const height = Math.max(1, Math.round(sourceCanvas.height * scale));
      const probe = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : (typeof document !== 'undefined' ? document.createElement('canvas') : null);
      if (!probe) return null;
      probe.width = width; probe.height = height;
      const context = probe.getContext('2d', { willReadFrequently: true });
      context.drawImage(sourceCanvas, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      const scaled = corners.map(point => ({ x: point.x * scale, y: point.y * scale }));
      const left = Math.max(0, Math.floor(Math.min(scaled[0].x, scaled[1].x) - width * 0.10));
      const right = Math.min(width - 1, Math.ceil(Math.max(scaled[0].x, scaled[1].x) + width * 0.10));
      const estimatedTop = (scaled[0].y + scaled[1].y) / 2;
      const searchTop = Math.max(0, Math.floor(estimatedTop - height * 0.12));
      const searchBottom = Math.min(Math.floor(height * 0.24), Math.ceil(estimatedTop + height * 0.12));
      const threshold = 12;
      let best = null;
      const gapLimit = Math.max(3, width * 0.02);
      for (let y = searchTop; y <= searchBottom; y++) {
        const hits = [];
        for (let x = left; x <= right; x++) {
          let strength = 0, edgeY = y;
          for (let sampleY = Math.max(0, y - 2); sampleY <= Math.min(height - 2, y + 2); sampleY++) {
            const first = (sampleY * width + x) * 4, second = first + width * 4;
            const difference = Math.abs(pixels[first] - pixels[second]) +
              Math.abs(pixels[first + 1] - pixels[second + 1]) +
              Math.abs(pixels[first + 2] - pixels[second + 2]);
            if (difference > strength) { strength = difference; edgeY = sampleY; }
          }
          if (strength >= threshold) hits.push({ x, y: edgeY, strength });
        }
        let start = 0;
        for (let index = 1; index <= hits.length; index++) {
          if (index === hits.length || hits[index].x - hits[index - 1].x > gapLimit) {
            const run = hits.slice(start, index);
            if (run.length >= 12) {
              const span = run[run.length - 1].x - run[0].x;
              const score = span + Math.min(20, run.reduce((sum, point) => sum + point.strength, 0) / run.length) * 0.2;
              if (!best || score > best.score) best = { run, score, span };
            }
            start = index;
          }
        }
      }
      if (!best || best.span < (scaled[1].x - scaled[0].x) * 0.58) return null;
      const meanX = best.run.reduce((sum, point) => sum + point.x, 0) / best.run.length;
      const meanY = best.run.reduce((sum, point) => sum + point.y, 0) / best.run.length;
      const slope = best.run.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) /
        Math.max(1, best.run.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0));
      const intercept = meanY - slope * meanX;
      return [
        { x: best.run[0].x / scale, y: (slope * best.run[0].x + intercept) / scale },
        { x: best.run[best.run.length - 1].x / scale, y: (slope * best.run[best.run.length - 1].x + intercept) / scale },
        corners[2], corners[3]
      ];
    } catch (_) { return null; }
  }

  function refineSpreadOuterSide(sourceCanvas, corners, missingLeft) {
    if (!sourceCanvas || !corners || corners.length !== 4) return null;
    try {
      const scale = Math.min(1, 1000 / Math.max(sourceCanvas.width, sourceCanvas.height));
      const width = Math.max(1, Math.round(sourceCanvas.width * scale));
      const height = Math.max(1, Math.round(sourceCanvas.height * scale));
      const probe = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : (typeof document !== 'undefined' ? document.createElement('canvas') : null);
      if (!probe) return null;
      probe.width = width; probe.height = height;
      const context = probe.getContext('2d', { willReadFrequently: true });
      context.drawImage(sourceCanvas, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      const scaled = corners.map(point => ({ x: point.x * scale, y: point.y * scale }));
      const firstIndex = missingLeft ? 0 : 1, secondIndex = missingLeft ? 3 : 2;
      const first = scaled[firstIndex], second = scaled[secondIndex];
      const radius = Math.max(8, width * 0.10);
      let bestX = (first.x + second.x) / 2, bestScore = 0;
      for (let x = Math.max(0, Math.floor(bestX - radius)); x < Math.min(width - 1, bestX + radius); x++) {
        let score = 0, count = 0;
        for (let step = 0.12; step <= 0.88; step += 0.025) {
          const y = Math.round(first.y + (second.y - first.y) * step);
          const offset = (y * width + x) * 4;
          score += Math.abs(pixels[offset] - pixels[offset + 4]) +
            Math.abs(pixels[offset + 1] - pixels[offset + 5]) +
            Math.abs(pixels[offset + 2] - pixels[offset + 6]);
          count++;
        }
        const average = score / Math.max(1, count);
        if (average > bestScore) { bestScore = average; bestX = x; }
      }
      if (bestScore < 4 || Math.abs(bestX - (first.x + second.x) / 2) > radius * 0.98) return null;
      const refinedFirst = { x: bestX / scale, y: first.y / scale };
      const refinedSecond = { x: bestX / scale, y: second.y / scale };
      const result = corners.map(point => ({ x: point.x, y: point.y }));
      result[firstIndex] = refinedFirst;
      result[secondIndex] = refinedSecond;
      return result;
    } catch (_) { return null; }
  }

  function detectSpreadQuad(cv, source, sourceCanvas, scale) {
    if (!cv || !source || !source.data || !sourceCanvas || !cv.Mat) return null;
    const width = source.cols, height = source.rows;
    const mask = new cv.Mat(height, width, cv.CV_8UC1);
    const cleaned = new cv.Mat();
    const hierarchy = new cv.Mat();
    const contours = new cv.MatVector();
    const kernelSize = Math.max(3, Math.round(Math.min(width, height) * 0.018) | 1);
    const kernel = cv.Mat.ones(kernelSize, kernelSize, cv.CV_8U);
    let best = null;
    let bestScore = -1;
    try {
      if (!fillBorderContrastMask(source, mask)) return null;
      cv.morphologyEx(mask, cleaned, cv.MORPH_CLOSE, kernel);
      cv.findContours(cleaned, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (let index = 0; index < contours.size(); index++) {
        const contour = contours.get(index);
        const hull = new cv.Mat();
        const polygon = new cv.Mat();
        try {
          const contourArea = Math.abs(cv.contourArea(contour));
          if (contourArea < width * height * 0.16 || contourArea > width * height * 0.92) continue;
          cv.convexHull(contour, hull, false, true);
          const hullArea = Math.abs(cv.contourArea(hull));
          if (!hullArea || contourArea / hullArea < 0.48) continue;
          const perimeter = cv.arcLength(hull, true);
          let points = null;
          for (const epsilon of [0.008, 0.012, 0.018, 0.025, 0.035, 0.05]) {
            cv.approxPolyDP(hull, polygon, epsilon * perimeter, true);
            if (polygon.rows === 4 && cv.isContourConvex(polygon)) {
              points = orderCorners(pointsFromMat(polygon));
              break;
            }
          }
          if (!points) {
            const rect = cv.minAreaRect(hull);
            const angle = rect.angle * Math.PI / 180;
            const cosine = Math.cos(angle), sine = Math.sin(angle);
            points = orderCorners([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => ({
              x: rect.center.x + x * rect.size.width * cosine / 2 - y * rect.size.height * sine / 2,
              y: rect.center.y + x * rect.size.width * sine / 2 + y * rect.size.height * cosine / 2
            })));
          }
          const refinedBottom = refineSpreadBottomEdge(sourceCanvas, points.map(point => ({
            x: point.x / scale, y: point.y / scale
          })));
          if (refinedBottom) points = refinedBottom.map(point => ({ x: point.x * scale, y: point.y * scale }));
          const sides = points.map((point, side) => {
            const next = points[(side + 1) % 4];
            return Math.hypot(next.x - point.x, next.y - point.y);
          });
          const horizontal = (sides[0] + sides[2]) / 2;
          const vertical = (sides[1] + sides[3]) / 2;
          const aspect = Math.max(horizontal, vertical) / Math.max(1, Math.min(horizontal, vertical));
          const area = polygonArea(points);
          const areaRatio = area / (width * height);
          // Some phone photos are framed tightly around the certificate. Keep
          // real corners close to the image edge, while still rejecting
          // minAreaRect candidates that spill outside the captured frame.
          if (points.some(point => point.x < -width * 0.002 || point.y < -height * 0.002 ||
              point.x > width * 1.002 || point.y > height * 1.002)) continue;
          if (aspect < 1.12 || aspect > 2.5 || areaRatio < 0.16 || areaRatio > 0.92) continue;
          const oppositeMismatch = Math.max(
            Math.max(sides[0], sides[2]) / Math.max(1, Math.min(sides[0], sides[2])),
            Math.max(sides[1], sides[3]) / Math.max(1, Math.min(sides[1], sides[3]))
          );
          if (oppositeMismatch > 2.2) continue;
          const score = areaRatio * Math.exp(-Math.abs(Math.log(aspect / 1.65))) *
            Math.min(1, contourArea / Math.max(1, area));
          if (score <= bestScore) continue;
          bestScore = score;
          const corners = points.map(point => ({ x: point.x / scale, y: point.y / scale }));
          const xs = corners.map(point => point.x), ys = corners.map(point => point.y);
          const x = Math.max(0, Math.floor(Math.min(...xs))), y = Math.max(0, Math.floor(Math.min(...ys)));
          const right = Math.min(sourceCanvas.width, Math.ceil(Math.max(...xs)));
          const bottom = Math.min(sourceCanvas.height, Math.ceil(Math.max(...ys)));
          best = { x, y, width: right - x, height: bottom - y, corners,
            detected: true, method: 'opencv', paperShape: true, paperConfidence: 0.86,
            detectionVariant: 'spread-border-quad' };
        } finally { contour.delete(); hull.delete(); polygon.delete(); }
      }
      return best;
    } catch (error) {
      console.info('Bỏ qua dò tứ giác dự phòng cho giấy mở hai mặt.', error);
      return null;
    } finally {
      mask.delete(); cleaned.delete(); hierarchy.delete(); contours.delete(); kernel.delete();
    }
  }

  function detect(cv, source, blurred, sourceCanvas, scale, options = {}) {
    if (options.documentType && options.documentType.startsWith('cccd')) return null;
    if (!source || !blurred || !cv || !cv.Mat) return null;
    const width = source.cols, height = source.rows;
    const mask = new cv.Mat(height, width, cv.CV_8UC1);
    const closed = new cv.Mat();
    const smooth = new cv.Mat();
    const hierarchy = new cv.Mat();
    const kernelSize = Math.max(3, Math.round(Math.min(width, height) * 0.012) | 1);
    const kernel = cv.Mat.ones(kernelSize, kernelSize, cv.CV_8U);
    let best = null;
    try {
      // Otsu adapts to the actual lighting; extra levels retain shaded paper edges.
      const threshold = cv.threshold(blurred, mask, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      cv.GaussianBlur(source, smooth, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
      const levels = options.fast ? [threshold, threshold + 12] : [threshold, threshold - 12, threshold + 12];
      for (const level of levels) {
        const cutoff = Math.max(110, Math.min(245, level));
        const pixels = smooth.data, gray = blurred.data, bits = mask.data;
        for (let i = 0, p = 0; i < bits.length; i++, p += 4) {
          const maximum = Math.max(pixels[p], pixels[p + 1], pixels[p + 2]);
          const minimum = Math.min(pixels[p], pixels[p + 1], pixels[p + 2]);
          bits[i] = gray[i] >= cutoff && maximum - minimum <= 58 ? 255 : 0;
        }
        // Close text strokes and small crease shadows before fitting the outer edge.
        cv.morphologyEx(mask, closed, cv.MORPH_CLOSE, kernel);
        const contours = new cv.MatVector();
        try {
          cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
          for (let i = 0; i < contours.size(); i++) {
            const contour = contours.get(i);
            try {
              const candidate = fitOutline(cv, contour, width, height, sourceCanvas, scale);
              if (!candidate) continue;
              const score = polygonArea(candidate.corners) * candidate.paperConfidence;
              if (!best || score > polygonArea(best.corners) * best.paperConfidence) best = candidate;
            } finally { contour.delete(); }
          }
        } finally { contours.delete(); }
      }
      // Lamination glare can break every brightness-mask outline into small
      // pieces, especially on neutral stone floors. Join only nearby edge gaps
      // and fit the resulting closed outline. This pass is reserved for a
      // missing or clearly one-sided spread candidate.
      let preliminaryRatio = best ? polygonArea(best.corners) / (sourceCanvas.width * sourceCanvas.height) : 0;
      let preliminaryCenterX = best ? best.x + best.width / 2 : sourceCanvas.width / 2;
      const needsBrokenEdgePass = !best || Boolean(options.preferSpread && preliminaryRatio < 0.48 &&
        Math.abs(preliminaryCenterX - sourceCanvas.width / 2) > sourceCanvas.width * 0.10);
      if (needsBrokenEdgePass) {
        const edges = new cv.Mat();
        const joined = new cv.Mat();
        const edgeKernelSize = Math.max(5, Math.round(Math.min(width, height) * 0.022) | 1);
        const edgeKernel = cv.Mat.ones(edgeKernelSize, edgeKernelSize, cv.CV_8U);
        const contours = new cv.MatVector();
        try {
          cv.Canny(blurred, edges, 28, 105);
          cv.morphologyEx(edges, joined, cv.MORPH_CLOSE, edgeKernel);
          cv.findContours(joined, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
          for (let i = 0; i < contours.size(); i++) {
            const contour = contours.get(i);
            try {
              const candidate = fitOutline(cv, contour, width, height, sourceCanvas, scale, true);
              if (!candidate) continue;
              candidate.detectionVariant = 'joined-glare-edges';
              const score = polygonArea(candidate.corners) * candidate.paperConfidence;
              if (!best || score > polygonArea(best.corners) * best.paperConfidence) best = candidate;
            } finally { contour.delete(); }
          }
        } finally { edges.delete(); joined.delete(); edgeKernel.delete(); contours.delete(); }
      }
      const bestRatio = best ? polygonArea(best.corners) / (sourceCanvas.width * sourceCanvas.height) : 0;
      const bestCenterX = best ? best.x + best.width / 2 : sourceCanvas.width / 2;
      const oneSidedSpread = Boolean(options.preferSpread && best && bestRatio < 0.62 &&
        Math.abs(bestCenterX - sourceCanvas.width / 2) > sourceCanvas.width * 0.12);
      // Only pay for the extra colour pass when the regular detector did not
      // find a convincing full document, or when it found only one side of an
      // open two-colour certificate. Fast preview uses it only for that clear
      // one-sided case and remains bounded to the caller's small probe.
      const needsBorderContrast = !best || bestRatio < 0.32 || oneSidedSpread;
      const contrastMaskReady = needsBorderContrast &&
        // The border is the least contaminated background sample for a large
        // open spread. Try it first; hue segmentation remains the fallback for
        // strongly coloured supports where the border has mixed lighting.
        (fillBorderContrastMask(source, mask) || fillBackgroundContrastMask(source, mask));
      if (contrastMaskReady) {
        // Remove thin texture/noise paths before closing small gaps inside the
        // paper. Otherwise a woven support surface can connect the paper mask
        // to unrelated objects at the image border.
        cv.morphologyEx(mask, closed, cv.MORPH_OPEN, kernel);
        cv.morphologyEx(closed, mask, cv.MORPH_CLOSE, kernel);
        const contours = new cv.MatVector();
        try {
          cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
          for (let i = 0; i < contours.size(); i++) {
            const contour = contours.get(i);
            try {
              const candidate = fitOutline(cv, contour, width, height, sourceCanvas, scale, true);
              if (!candidate) continue;
              candidate.method = 'opencv';
              candidate.detectionVariant = 'background-contrast';
              const score = polygonArea(candidate.corners) * candidate.paperConfidence;
              if (!best || score > polygonArea(best.corners) * best.paperConfidence) best = candidate;
            } finally { contour.delete(); }
          }
        } finally { contours.delete(); }
      }
      if (options.preferSpread && (!best || polygonArea(best.corners) / (sourceCanvas.width * sourceCanvas.height) < 0.48)) {
        const spreadQuad = detectSpreadQuad(cv, source, sourceCanvas, scale);
        if (spreadQuad && (!best || polygonArea(spreadQuad.corners) > polygonArea(best.corners) * 1.10)) best = spreadQuad;
      }
      if (options.preferSpread && best && best.corners) {
        const bestArea = polygonArea(best.corners);
        const bestCenterX = best.x + best.width / 2;
        const oneSided = bestArea / (sourceCanvas.width * sourceCanvas.height) < 0.58 &&
          (bestCenterX < sourceCanvas.width * 0.40 || bestCenterX > sourceCanvas.width * 0.60);
        if (oneSided) {
          let recovered = recoverSpread(sourceCanvas, best);
          if (recovered && recovered.detectionVariant === 'spread-support') {
            const missingLeft = best.x + best.width / 2 > sourceCanvas.width * 0.60;
            const refined = refineSpreadOuterSide(sourceCanvas, recovered.corners, missingLeft);
            if (refined) {
              const xs = refined.map(point => point.x), ys = refined.map(point => point.y);
              const x = Math.max(0, Math.floor(Math.min(...xs))), y = Math.max(0, Math.floor(Math.min(...ys)));
              recovered = { ...recovered, corners: refined, x, y,
                width: Math.min(sourceCanvas.width, Math.ceil(Math.max(...xs))) - x,
                height: Math.min(sourceCanvas.height, Math.ceil(Math.max(...ys))) - y };
            }
          }
          if (recovered && polygonArea(recovered.corners) > bestArea * 1.25 &&
              polygonArea(recovered.corners) < sourceCanvas.width * sourceCanvas.height * 0.92) best = recovered;
        }
      }
      if (options.preferSpread && best && best.corners && best.paperConfidence < 0.8 &&
          best.detectionVariant !== 'spread-border-quad') {
        const refinedTop = refineSpreadTopEdge(sourceCanvas, best.corners);
        if (refinedTop) {
          const sides = refinedTop.map((point, index) => Math.hypot(
            refinedTop[(index + 1) % 4].x - point.x, refinedTop[(index + 1) % 4].y - point.y));
          const area = polygonArea(refinedTop);
          if (area > sourceCanvas.width * sourceCanvas.height * 0.14 &&
              Math.max(sides[0], sides[2]) / Math.max(1, Math.min(sides[0], sides[2])) < 2.2) {
            best.corners = refinedTop;
            const xs = refinedTop.map(point => point.x), ys = refinedTop.map(point => point.y);
            best.x = Math.max(0, Math.floor(Math.min(...xs)));
            best.y = Math.max(0, Math.floor(Math.min(...ys)));
            best.width = Math.min(sourceCanvas.width, Math.ceil(Math.max(...xs))) - best.x;
            best.height = Math.min(sourceCanvas.height, Math.ceil(Math.max(...ys))) - best.y;
            best.detectionVariant = 'spread-edge-refined';
          }
        }
      }
      return best;
    } catch (error) {
      console.warn('Không thể dò thêm đường viền giấy A4.', error);
      return null;
    } finally {
      mask.delete(); closed.delete(); smooth.delete(); hierarchy.delete(); kernel.delete();
    }
  }

  // Prefer validated perspective corners over a box describing the same paper.
  function matchesBounds(paper, bounds) {
    if (!paper || !bounds || !bounds.detected || paper.paperConfidence < 0.8) return false;
    // Keep the wider fallback if a shaded strip may be absent from the paper mask.
    if (Math.abs(paper.x - bounds.x) > bounds.width * 0.045 ||
        Math.abs(paper.y - bounds.y) > bounds.height * 0.045 ||
        Math.abs(paper.x + paper.width - bounds.x - bounds.width) > bounds.width * 0.045 ||
        Math.abs(paper.y + paper.height - bounds.y - bounds.height) > bounds.height * 0.045) return false;
    const width = Math.max(0, Math.min(paper.x + paper.width, bounds.x + bounds.width) - Math.max(paper.x, bounds.x));
    const height = Math.max(0, Math.min(paper.y + paper.height, bounds.y + bounds.height) - Math.max(paper.y, bounds.y));
    const intersection = width * height;
    const union = paper.width * paper.height + bounds.width * bounds.height - intersection;
    return union > 0 && intersection / union >= 0.82;
  }

  root.A4DocumentDetector = { detect, detectSpreadQuad, matchesBounds, fillBackgroundContrastMask, fillBorderContrastMask, recoverSpread };
})(typeof self !== 'undefined' ? self : globalThis);
