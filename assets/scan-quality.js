/* Shared scan policy and bounded-memory image processing, for the page and its Worker. */
(function (root) {
  'use strict';

  const DEFAULT_DPI = 400;
  const MIN_REVIEW_DPI = 240;

  function releaseCanvas(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
  }

  function newCanvas(width, height) {
    const canvas = root.document && root.document.createElement
      ? root.document.createElement('canvas') : new root.OffscreenCanvas(width, height);
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  }

  function naturalDimensions(source, bounds) {
    const corners = bounds && bounds.corners;
    if (corners && corners.length === 4) {
      return {
        width: Math.max(Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y),
          Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y)),
        height: Math.max(Math.hypot(corners[1].x - corners[2].x, corners[1].y - corners[2].y),
          Math.hypot(corners[0].x - corners[3].x, corners[0].y - corners[3].y))
      };
    }
    return { width: bounds && bounds.width || source.width, height: bounds && bounds.height || source.height };
  }

  function verifiedFor300(evidence) {
    // A small preview or a high Laplacian score cannot establish small-text readability.
    // Only measured text/stroke evidence from every sampled region can enable this choice.
    return Boolean(evidence && evidence.source === 'verified-text-sampling' &&
      evidence.regionCount >= 5 && evidence.allRegionsClear === true &&
      evidence.minGlyphHeightAt300 >= 14 && evidence.minStrokeWidthAt300 >= 1.5 &&
      evidence.minContrast >= 64);
  }

  function outputPolicy(source, bounds, options) {
    options = options || {};
    const natural = naturalDimensions(source, bounds);
    if (!(natural.width > 0) || !(natural.height > 0)) throw new Error('Kích thước ảnh quét không hợp lệ.');
    const isCard = /^cccd/.test(String(options.documentType || ''));
    const landscape = natural.width >= natural.height;
    const shortMm = isCard ? 53.98 : options.documentFormat === 'a4' ? 210 : 297;
    const longMm = isCard ? 85.6 : options.documentFormat === 'a4' ? 297 : 420;
    const widthMm = landscape ? longMm : shortMm;
    const heightMm = landscape ? shortMm : longMm;
    const placement = Math.min(widthMm / natural.width, heightMm / natural.height);
    const verified = Number(options.dpi) !== 400 && verifiedFor300(options.qualityEvidence);
    const dpi = Number(options.dpi) === 300 || verified ? 300 : DEFAULT_DPI;
    const explicitEdge = Number.isFinite(options.targetLongEdge) && options.targetLongEdge > 0;
    // Legacy preview/diagnostic callers keep their explicit dimensions; production uses the physical DPI cap.
    const optimized = options.optimize !== false && !explicitEdge;
    const requestedScale = explicitEdge ? options.targetLongEdge / Math.max(natural.width, natural.height)
      : optimized ? placement / 25.4 * dpi : 1;
    const scale = Math.min(1, requestedScale);
    const pixelWidth = Math.max(1, Math.floor(natural.width * scale));
    const pixelHeight = Math.max(1, Math.floor(natural.height * scale));
    const effectiveDpi = Math.min(pixelWidth / (natural.width * placement) * 25.4,
      pixelHeight / (natural.height * placement) * 25.4);
    const lowResolution = effectiveDpi < MIN_REVIEW_DPI;
    const warnings = lowResolution ? ['Ảnh có khoảng ' + Math.round(effectiveDpi) +
      ' dpi trên khổ ' + (isCard ? 'CCCD' : options.documentFormat === 'a4' ? 'A4' : 'A3') +
      '; hãy kiểm tra chữ nhỏ hoặc chụp gần hơn, giữ rõ toàn bộ mép giấy.'] : [];
    // fitScanDimensions rounds to whole pixels. Use the floored physical ceiling on both axes,
    // so a 300 dpi page never rounds one pixel above its cap and needs a second JPEG encode later.
    const outputScale = optimized ? Math.min(pixelWidth / natural.width, pixelHeight / natural.height) : scale;
    return { targetLongEdge: Math.max(natural.width, natural.height) * outputScale,
      dpi, effectiveDpi, pixelWidth, pixelHeight, sourceWidth: natural.width, sourceHeight: natural.height,
      limited: scale < 1, optimized, quality: { lowResolution, warnings, detailAssessment: 'unverified',
        dpiSelection: Number(options.dpi) === 300 ? 'explicit' : verified ? 'verified-text-sampling' : 'safety' } };
  }

  function percentile(histogram, count, fraction) {
    let accumulated = 0;
    const target = Math.max(1, Math.ceil(count * fraction));
    for (let value = 0; value < histogram.length; value++) {
      accumulated += histogram[value];
      if (accumulated >= target) return value;
    }
    return 0;
  }

  function lightingProfileFromPixels(pixels, width, height) {
    if (!pixels || pixels.length < width * height * 4 || width < 1 || height < 1) {
      return { needsCorrection: false, assessment: 'unavailable', unevenness: 0, reference: 200 };
    }
    const histogram = new Uint32Array(256);
    const cells = [];
    const counts = new Uint32Array(25);
    for (let cell = 0; cell < 25; cell++) cells.push(new Uint32Array(256));
    let count = 0;
    let clipped = 0;
    const stride = Math.max(width, height) > 240 ? 2 : 1;
    for (let y = 0; y < height; y += stride) {
      const row = Math.min(4, Math.floor(y * 5 / height)) * 5;
      for (let x = 0; x < width; x += stride) {
        const index = (y * width + x) * 4;
        const red = pixels[index], green = pixels[index + 1], blue = pixels[index + 2];
        const value = (red * 77 + green * 150 + blue * 29) >> 8;
        const cell = row + Math.min(4, Math.floor(x * 5 / width));
        histogram[value]++;
        cells[cell][value]++;
        counts[cell]++;
        count++;
        if (red >= 253 && green >= 253 && blue >= 253) clipped++;
      }
    }
    const backgrounds = cells.map(function (histogram, index) { return percentile(histogram, counts[index], 0.8); }).sort(function (a, b) { return a - b; });
    const reference = percentile(histogram, count, 0.7);
    const unevenness = backgrounds[22] - backgrounds[2];
    const dark = reference < 155;
    return { needsCorrection: dark || unevenness > 24, assessment: 'estimated', reference,
      unevenness, dark, clippedFraction: count ? clipped / count : 0,
      // White paper often clips normally. This signal is informational, never proof of glare or readability.
      possibleGlare: clipped / count > 0.15 && backgrounds[22] - backgrounds[2] > 75 };
  }

  function lightingProfile(canvas) {
    let probe;
    try {
      const scale = Math.min(1, 384 / Math.max(canvas.width, canvas.height));
      probe = newCanvas(canvas.width * scale, canvas.height * scale);
      const context = probe.getContext('2d', { willReadFrequently: true });
      context.drawImage(canvas, 0, 0, probe.width, probe.height);
      const image = context.getImageData(0, 0, probe.width, probe.height);
      return lightingProfileFromPixels(image.data, probe.width, probe.height);
    } catch (error) {
      return { needsCorrection: true, assessment: 'unavailable', reference: 200, unevenness: 0 };
    } finally { releaseCanvas(probe); }
  }

  function gainLookup(reference) {
    const lookup = new Float32Array(256);
    for (let value = 0; value < 256; value++) {
      lookup[value] = Math.max(0.78, Math.min(1.28, Math.pow(reference / Math.max(32, value), 0.65)));
    }
    return lookup;
  }

  function correctLighting(canvas, cv, options) {
    options = options || {};
    const profile = lightingProfile(canvas);
    if (options.lighting === false || (!options.forceLighting && !profile.needsCorrection)) {
      return { applied: false, skipped: options.lighting === false ? 'disabled' : 'even-light', profile };
    }
    if (!cv || !cv.Mat) return { applied: false, skipped: 'opencv-unavailable', profile };
    let analysis, source, gray, illumination, fullIllumination;
    try {
      const scale = Math.min(1, 512 / Math.max(canvas.width, canvas.height));
      analysis = newCanvas(canvas.width * scale, canvas.height * scale);
      const analysisContext = analysis.getContext('2d', { willReadFrequently: true });
      analysisContext.drawImage(canvas, 0, 0, analysis.width, analysis.height);
      source = cv.matFromImageData(analysisContext.getImageData(0, 0, analysis.width, analysis.height));
      gray = new cv.Mat();
      illumination = new cv.Mat();
      fullIllumination = new cv.Mat();
      cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
      const sigma = Math.max(4, Math.min(14, Math.min(analysis.width, analysis.height) * 0.025));
      cv.GaussianBlur(gray, illumination, new cv.Size(0, 0), sigma, sigma, cv.BORDER_REPLICATE);
      const histogram = new Uint32Array(256);
      for (let index = 0; index < illumination.data.length; index++) histogram[illumination.data[index]]++;
      const reference = Math.max(150, Math.min(235, percentile(histogram, illumination.data.length, 0.7)));
      const gains = gainLookup(reference);
      cv.resize(illumination, fullIllumination, new cv.Size(canvas.width, canvas.height), 0, 0, cv.INTER_LINEAR);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const lightMap = fullIllumination.data;
      // A strip bounds temporary RGBA memory: an A3 page no longer allocates a second full-size RGBA image.
      const stripHeight = Math.min(256, canvas.height);
      for (let y = 0; y < canvas.height; y += stripHeight) {
        const height = Math.min(stripHeight, canvas.height - y);
        const image = context.getImageData(0, y, canvas.width, height);
        const pixels = image.data;
        const mapStart = y * canvas.width;
        for (let pixel = 0, index = 0; pixel < canvas.width * height; pixel++, index += 4) {
          const gain = gains[lightMap[mapStart + pixel]];
          if (gain > 0.995 && gain < 1.005) continue;
          const maximum = Math.max(pixels[index], pixels[index + 1], pixels[index + 2]);
          const minimum = Math.min(pixels[index], pixels[index + 1], pixels[index + 2]);
          const protection = maximum ? Math.max(0, 1 - (maximum - minimum) * 4 / maximum) : 1;
          const safeGain = 1 + (gain - 1) * protection;
          pixels[index] = Math.min(255, pixels[index] * safeGain);
          pixels[index + 1] = Math.min(255, pixels[index + 1] * safeGain);
          pixels[index + 2] = Math.min(255, pixels[index + 2] * safeGain);
        }
        context.putImageData(image, 0, y);
      }
      return { applied: true, profile, reference };
    } catch (error) {
      return { applied: false, skipped: 'processing-error', profile, error: String(error) };
    } finally {
      [source, gray, illumination, fullIllumination].forEach(function (mat) { if (mat && mat.delete) mat.delete(); });
      releaseCanvas(analysis);
    }
  }

  function warpPerspective(sourceCanvas, corners, output, cv) {
    let input, source, sourcePoints, destinationPoints, transform, warped;
    const target = newCanvas(output.width, output.height);
    try {
      const natural = naturalDimensions(sourceCanvas, { corners });
      const left = Math.max(0, Math.floor(Math.min.apply(null, corners.map(function (p) { return p.x; }))) - 2);
      const top = Math.max(0, Math.floor(Math.min.apply(null, corners.map(function (p) { return p.y; }))) - 2);
      const right = Math.min(sourceCanvas.width, Math.ceil(Math.max.apply(null, corners.map(function (p) { return p.x; }))) + 2);
      const bottom = Math.min(sourceCanvas.height, Math.ceil(Math.max.apply(null, corners.map(function (p) { return p.y; }))) + 2);
      const scale = Math.min(1, Math.max(output.width / natural.width, output.height / natural.height) * 1.12);
      input = newCanvas((right - left) * scale, (bottom - top) * scale);
      const context = input.getContext('2d', { willReadFrequently: true });
      context.imageSmoothingQuality = 'high';
      context.drawImage(sourceCanvas, left, top, right - left, bottom - top, 0, 0, input.width, input.height);
      source = cv.matFromImageData(context.getImageData(0, 0, input.width, input.height));
      const scaleX = input.width / (right - left), scaleY = input.height / (bottom - top);
      const positions = [];
      corners.forEach(function (point) { positions.push((point.x - left) * scaleX, (point.y - top) * scaleY); });
      sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, positions);
      destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, target.width - 1, 0,
        target.width - 1, target.height - 1, 0, target.height - 1]);
      transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
      warped = new cv.Mat();
      cv.warpPerspective(source, warped, transform, new cv.Size(target.width, target.height), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
      cv.imshow(target, warped);
      return target;
    } catch (error) {
      releaseCanvas(target);
      throw error;
    } finally {
      [source, sourcePoints, destinationPoints, transform, warped].forEach(function (mat) { if (mat && mat.delete) mat.delete(); });
      releaseCanvas(input);
    }
  }

  root.ScanQuality = { DEFAULT_DPI, MIN_REVIEW_DPI, outputPolicy, naturalDimensions,
    lightingProfile, lightingProfileFromPixels, gainLookup, correctLighting, warpPerspective, releaseCanvas };
})(typeof window !== 'undefined' ? window : self);
