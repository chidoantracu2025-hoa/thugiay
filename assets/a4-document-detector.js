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
    if (missingLeft) for (let x = edge - 1; x >= 0; x--) {
      if (hits[x] >= requiredHits) { boundary = x; gap = 0; }
      else if (++gap > 3) break;
    } else for (let x = edge + 1; x < width; x++) {
      if (hits[x] >= requiredHits) { boundary = x; gap = 0; }
      else if (++gap > 3) break;
    }
    edge = boundary;
    const recoveredX = edge / scale;
    const recoveredWidth = missingLeft ? page.x + page.width - recoveredX : recoveredX - page.x;
    if (recoveredWidth < page.width * 1.45 || recoveredWidth < sourceWidth * 0.60) return null;
    const corners = page.corners;
    function lineY(first, second, x) {
      return first.y + (second.y - first.y) * (x - first.x) / Math.max(1, second.x - first.x);
    }
    const expanded = missingLeft
      ? [{ x: recoveredX, y: lineY(corners[0], corners[1], recoveredX) }, corners[1], corners[2],
        { x: recoveredX, y: lineY(corners[3], corners[2], recoveredX) }]
      : [corners[0], { x: recoveredX, y: lineY(corners[0], corners[1], recoveredX) },
        { x: recoveredX, y: lineY(corners[3], corners[2], recoveredX) }, corners[3]];
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
      if (((!options.fast && bestRatio < 0.32) || oneSidedSpread || (options.fast && !best)) &&
          fillBackgroundContrastMask(source, mask)) {
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

  root.A4DocumentDetector = { detect, matchesBounds, fillBackgroundContrastMask, recoverSpread };
})(typeof self !== 'undefined' ? self : globalThis);
