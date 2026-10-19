/* Local OpenCV processing in a worker; the UI retains the source image. */
const document = { createElement: () => new OffscreenCanvas(1, 1) };
const window = self;
// OpenCV's canvas helpers expect these browser constructors.
const HTMLCanvasElement = OffscreenCanvas;
const HTMLImageElement = class {};
const state = { opencvReady: false, scanner: null, scanMode: 'opencv' };
importScripts('../opencv.js', '../jscanify.min.js', './a4-document-detector.js', './scan-quality.js');
const ready = Promise.resolve(self.cv).then(module => {
  window.cv = module;
  state.opencvReady = Boolean(module && module.Mat && module.findContours);
  if (state.opencvReady && typeof self.jscanify === 'function') state.scanner = new self.jscanify();
  if (!state.opencvReady) throw new Error('OpenCV chưa sẵn sàng');
});
// Keep each request's settings stable while OpenCV loads or other scans run.
let scanQueue = Promise.resolve();
self.onmessage = ({ data }) => {
  const request = Object.assign({}, data, { options: Object.assign({}, data.options) });
  scanQueue = scanQueue.then(() => processScanRequest(request), () => processScanRequest(request));
};
async function processScanRequest(data) {
  const { id, bitmap, options, mode } = data;
  const envelope = { id };
  if (typeof data.sessionId === 'string') envelope.sessionId = data.sessionId;
  let bitmapClosed = false;
  let output = null;
  let source = null;
  let scan = null;
  let sourceIsBitmap = false;
  try {
    await ready;
    state.scanMode = ['opencv', 'fallback', 'all'].includes(mode) ? mode : 'opencv';
    // A large native RGBA canvas can cost 100+ MB. All production detection probes and the
    // bounded warp accept CanvasImageSource, so keep the transferred bitmap until they finish.
    sourceIsBitmap = typeof ImageBitmap !== 'undefined' && bitmap instanceof ImageBitmap &&
      Math.max(bitmap.width, bitmap.height) > 960;
    source = sourceIsBitmap ? bitmap : new OffscreenCanvas(bitmap.width, bitmap.height);
    if (!sourceIsBitmap) {
      source.getContext('2d').drawImage(bitmap, 0, 0);
      bitmap.close();
      bitmapClosed = true;
    }
    if (data.action === 'PREVIEW') {
      const settings = Object.assign({}, options, { fast: true, maxDimension: 480 });
      const bounds = state.scanMode === 'fallback' ? detectDocumentByColorFallback(source)
        : detectDocumentWithOpenCv(source, false, settings) || detectDocumentByColorFallback(source);
      self.postMessage(Object.assign({}, envelope, { bounds }));
      return;
    }
    scan = prepareScan(source, options, state.scanMode);
    output = scan.canvas.transferToImageBitmap();
    self.postMessage(Object.assign({}, envelope, { bitmap: output, detected: scan.detected,
      method: scan.method, quality: scan.quality, dpi: scan.dpi, effectiveDpi: scan.effectiveDpi,
      lighting: scan.lighting, timings: scan.timings }), [output]);
    output = null;
  } catch (error) {
    if (output) output.close();
    self.postMessage(Object.assign({}, envelope, { error: String(error) }));
  } finally {
    if (!bitmapClosed && bitmap && typeof bitmap.close === 'function') bitmap.close();
    if (scan && scan.canvas && scan.canvas !== source) { scan.canvas.width = 0; scan.canvas.height = 0; }
    if (source && !sourceIsBitmap) { source.width = 0; source.height = 0; }
  }
}
    function detectDocumentBounds(sourceCanvas, mode = state.scanMode, options = {}) {
      const candidates = [];
      if (mode !== 'fallback') {
        const openCvBounds = detectDocumentWithOpenCv(sourceCanvas, false, options);
        if (openCvBounds) candidates.push(openCvBounds);
      }
      const jscanifyBounds = mode === 'all' ? detectDocumentWithJscanify(sourceCanvas) : null;
      if (jscanifyBounds) candidates.push(jscanifyBounds);
      const colorBounds = detectDocumentByColorFallback(sourceCanvas);
      const paperMatchesColor = window.A4DocumentDetector && candidates.some(candidate =>
        candidate.paperShape && window.A4DocumentDetector.matchesBounds(candidate, colorBounds));
      if (colorBounds && !paperMatchesColor) candidates.push(colorBounds);

      const detectedCandidates = candidates.filter(candidate => candidate && candidate.detected);
      if (!detectedCandidates.length) return colorBounds || candidates[0] || { x: 0, y: 0, width: sourceCanvas.width, height: sourceCanvas.height, detected: false, method: 'fallback' };
      return detectedCandidates.reduce((best, candidate) =>
        scoreDocumentBounds(candidate, sourceCanvas, options) > scoreDocumentBounds(best, sourceCanvas, options)
          ? candidate
          : best
      );
    }

    function scoreDocumentBounds(bounds, sourceCanvas, options = {}) {
      if (!bounds) return -1;
      const boxArea = bounds.corners
        ? Math.abs(bounds.corners.reduce((sum, point, index, points) => {
          const next = points[(index + 1) % points.length];
          return sum + point.x * next.y - next.x * point.y;
        }, 0)) / 2
        : bounds.width * bounds.height;
      const frameArea = sourceCanvas.width * sourceCanvas.height;
      const areaRatio = boxArea / frameArea;
      const aspect = Math.max(bounds.width, bounds.height) / Math.max(1, Math.min(bounds.width, bounds.height));
      const aspectFit = Math.exp(-Math.abs(Math.log(aspect / (options.documentType && options.documentType.startsWith('cccd') ? 1.586 : Math.SQRT2))));
      let score = areaRatio * (0.7 + 0.3 * aspectFit);
      score += bounds.corners ? 0.025 : 0;
      score += bounds.method === 'opencv' ? 0.015 : bounds.method === 'jscanify' ? 0.01 : 0;
      if (areaRatio > 0.88) score -= 1;
      else if (areaRatio > 0.82) score -= 0.3;
      if (areaRatio < 0.06) score -= 0.2;
      if (options.preferSpread && areaRatio > 0.2 && aspect < 2.2) score += 0.08;
      if (bounds.corners) {
        const margin = Math.min(...bounds.corners.map(point => Math.min(point.x, point.y, sourceCanvas.width - point.x, sourceCanvas.height - point.y)));
        const shortEdge = Math.min(sourceCanvas.width, sourceCanvas.height);
        if (margin <= 0) score -= bounds.detectionVariant === 'background-contrast' ? 0.12 : 0.6;
        else if (margin < shortEdge * 0.003) score -= bounds.detectionVariant === 'background-contrast' ? 0.06 : 0.35;
        else if (margin > shortEdge * 0.01) score += 0.01;
      }
      return score;
    }

    function detectDocumentByColorFallback(sourceCanvas) {
      const sourceW = sourceCanvas.width;
      const sourceH = sourceCanvas.height;
      const probe = document.createElement('canvas');
      const scale = Math.min(1, 320 / Math.max(sourceW, sourceH));
      const probeW = Math.max(1, Math.round(sourceW * scale));
      const probeH = Math.max(1, Math.round(sourceH * scale));
      probe.width = probeW;
      probe.height = probeH;

      const probeCtx = probe.getContext('2d', { willReadFrequently: true });
      probeCtx.drawImage(sourceCanvas, 0, 0, probeW, probeH);
      const pixels = probeCtx.getImageData(0, 0, probeW, probeH).data;
      const cornerSamples = [];
      const sampleRadius = Math.max(2, Math.floor(Math.min(probeW, probeH) * 0.025));
      const cornerCenters = [
        [sampleRadius, sampleRadius],
        [probeW - sampleRadius - 1, sampleRadius],
        [sampleRadius, probeH - sampleRadius - 1],
        [probeW - sampleRadius - 1, probeH - sampleRadius - 1]
      ];

      cornerCenters.forEach(([centerX, centerY]) => {
        let red = 0;
        let green = 0;
        let blue = 0;
        let count = 0;

        for (let y = Math.max(0, centerY - 2); y <= Math.min(probeH - 1, centerY + 2); y++) {
          for (let x = Math.max(0, centerX - 2); x <= Math.min(probeW - 1, centerX + 2); x++) {
            const i = (y * probeW + x) * 4;
            red += pixels[i];
            green += pixels[i + 1];
            blue += pixels[i + 2];
            count++;
          }
        }

        cornerSamples.push([red / count, green / count, blue / count]);
      });

      const background = [0, 1, 2].map(channel =>
        cornerSamples.reduce((sum, sample) => sum + sample[channel], 0) / cornerSamples.length
      );
      const columnHits = new Uint16Array(probeW);
      const rowHits = new Uint16Array(probeH);
      const threshold = 48;

      for (let y = 0; y < probeH; y++) {
        for (let x = 0; x < probeW; x++) {
          const i = (y * probeW + x) * 4;
          const dr = pixels[i] - background[0];
          const dg = pixels[i + 1] - background[1];
          const db = pixels[i + 2] - background[2];
          if (Math.sqrt(dr * dr + dg * dg + db * db) >= threshold) {
            columnHits[x]++;
            rowHits[y]++;
          }
        }
      }

      const minColumnHits = Math.max(2, Math.round(probeH * 0.08));
      const minRowHits = Math.max(2, Math.round(probeW * 0.08));
      let left = 0;
      let right = probeW - 1;
      let top = 0;
      let bottom = probeH - 1;

      while (left < probeW && columnHits[left] < minColumnHits) left++;
      while (right >= 0 && columnHits[right] < minColumnHits) right--;
      while (top < probeH && rowHits[top] < minRowHits) top++;
      while (bottom >= 0 && rowHits[bottom] < minRowHits) bottom--;

      const boxW = right - left + 1;
      const boxH = bottom - top + 1;
      const valid = left < right && top < bottom &&
        boxW >= probeW * 0.25 && boxH >= probeH * 0.25 &&
        boxW * boxH >= probeW * probeH * 0.1 &&
        boxW * boxH <= probeW * probeH * 0.9 &&
        left > probeW * 0.005 && top > probeH * 0.005 &&
        right < probeW * 0.995 && bottom < probeH * 0.995;

      if (!valid) {
        const marginX = 0;
        const marginY = 0;
        return { x: marginX, y: marginY, width: sourceW - marginX * 2, height: sourceH - marginY * 2, detected: false, method: 'fallback' };
      }

      const padX = Math.max(2, Math.round(boxW * 0.015));
      const padY = Math.max(2, Math.round(boxH * 0.015));
      const x = Math.max(0, Math.floor((left - padX) / scale));
      const y = Math.max(0, Math.floor((top - padY) / scale));
      const endX = Math.min(sourceW, Math.ceil((right + padX + 1) / scale));
      const endY = Math.min(sourceH, Math.ceil((bottom + padY + 1) / scale));

      return { x, y, width: endX - x, height: endY - y, detected: true, method: 'fallback' };
    }

    function orderDocumentCorners(points) {
      const centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const centerY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
      const clockwise = [...points].sort((a, b) =>
        Math.atan2(a.y - centerY, a.x - centerX) - Math.atan2(b.y - centerY, b.x - centerX)
      );
      const topLeftIndex = clockwise.reduce((bestIndex, point, index) => {
        const best = clockwise[bestIndex];
        return point.x + point.y < best.x + best.y ? index : bestIndex;
      }, 0);
      return clockwise.map((_, index) => clockwise[(topLeftIndex + index) % clockwise.length]);
    }

    function detectDocumentWithOpenCv(sourceCanvas, includeJscanify = false, options = {}) {
      if (!state.opencvReady) return null;

      if (includeJscanify) {
        const jscanifyBounds = detectDocumentWithJscanify(sourceCanvas);
        if (jscanifyBounds) return jscanifyBounds;
      }

      const cv = window.cv;
      let source;
      let gray;
      let blurred;
      let edges;
      let dilated;
      let kernel;
      let contours;
      let hierarchy;
      let selected = null;

      try {
        const maxDimension = options.maxDimension || 960;
        const scale = Math.min(1, maxDimension / Math.max(sourceCanvas.width, sourceCanvas.height));
        const width = Math.max(1, Math.round(sourceCanvas.width * scale));
        const height = Math.max(1, Math.round(sourceCanvas.height * scale));
        let probe = sourceCanvas;
        if (scale < 1 || typeof sourceCanvas.getContext !== 'function') {
          probe = document.createElement('canvas');
          probe.width = width;
          probe.height = height;
          probe.getContext('2d', { willReadFrequently: true }).drawImage(sourceCanvas, 0, 0, width, height);
        }

        source = cv.matFromImageData(probe.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height));
        gray = new cv.Mat();
        blurred = new cv.Mat();
        kernel = cv.Mat.ones(3, 3, cv.CV_8U);
        cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
        selected = findOpenCvDocumentContour(cv, blurred, width, height, sourceCanvas, scale, kernel, options, source);
      } catch (error) {
        console.warn('OpenCV không nhận diện được khung tài liệu ở khung hình này.', error);
      } finally {
        [source, gray, blurred, edges, dilated, kernel, contours, hierarchy].forEach(mat => {
          if (mat && mat.delete) mat.delete();
        });
      }

      return selected;
    }

    function findOpenCvDocumentContour(cv, blurred, width, height, sourceCanvas, scale, kernel, options = {}, source = null) {
      const candidates = [];
      const edgeThresholds = options.fast
        ? [[50, 150]]
        : [[15, 45], [35, 105], [50, 150], [70, 210]];

      for (const [lowThreshold, highThreshold] of edgeThresholds) {
        const edges = new cv.Mat();
        const dilated = new cv.Mat();
        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        try {
          cv.Canny(blurred, edges, lowThreshold, highThreshold);
          cv.dilate(edges, dilated, kernel);
          cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

          const minArea = width * height * (options.fast ? 0.025 : 0.02);
          for (let index = 0; index < contours.size(); index++) {
            const contour = contours.get(index);
            const polygon = new cv.Mat();
            try {
              const perimeter = cv.arcLength(contour, true);
              cv.approxPolyDP(contour, polygon, 0.02 * perimeter, true);
              const area = Math.abs(cv.contourArea(polygon));
              if (polygon.rows !== 4 || area < minArea || area >= width * height * 0.94 || !cv.isContourConvex(polygon)) continue;

              const points = [];
              for (let pointIndex = 0; pointIndex < 4; pointIndex++) {
                points.push({ x: polygon.data32S[pointIndex * 2], y: polygon.data32S[pointIndex * 2 + 1] });
              }
              const corners = orderDocumentCorners(points);
              const topWidth = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
              const bottomWidth = Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y);
              const leftHeight = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
              const rightHeight = Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y);
              const ratio = Math.max(topWidth, bottomWidth) / Math.max(1, Math.max(leftHeight, rightHeight));
              if (ratio < 0.22 || ratio > 4.5) continue;

              const xs = corners.map(point => point.x);
              const ys = corners.map(point => point.y);
              const left = Math.max(0, Math.floor(Math.min(...xs) / scale));
              const top = Math.max(0, Math.floor(Math.min(...ys) / scale));
              const right = Math.min(sourceCanvas.width, Math.ceil(Math.max(...xs) / scale));
              const bottom = Math.min(sourceCanvas.height, Math.ceil(Math.max(...ys) / scale));
              const scaledCorners = corners.map(point => ({ x: point.x / scale, y: point.y / scale }));
              const candidate = {
                x: left,
                y: top,
                width: right - left,
                height: bottom - top,
                corners: scaledCorners,
                detected: true,
                method: 'opencv'
              };

              candidates.push(candidate);
            } finally {
              contour.delete();
              polygon.delete();
            }
          }
        } finally {
          edges.delete();
          dilated.delete();
          contours.delete();
          hierarchy.delete();
        }
      }

      // Paper masks tolerate curved/torn outlines that cannot simplify to four vertices.
      if (window.A4DocumentDetector) {
        const paper = window.A4DocumentDetector.detect(cv, source, blurred, sourceCanvas, scale, options);
        if (paper) candidates.push(paper);
      }

      if (!candidates.length) return null;
      if (options.preferSpread) candidates.push(...mergeAdjacentDocumentPages(candidates, sourceCanvas));
      candidates.sort((a, b) =>
        scoreDocumentBounds(b, sourceCanvas, options) - scoreDocumentBounds(a, sourceCanvas, options)
      );
      return candidates[0];
    }

    function mergeAdjacentDocumentPages(candidates, sourceCanvas) {
      const merged = [];
      for (let firstIndex = 0; firstIndex < candidates.length; firstIndex++) {
        for (let secondIndex = firstIndex + 1; secondIndex < candidates.length; secondIndex++) {
          const first = candidates[firstIndex];
          const second = candidates[secondIndex];
          const firstCenterX = first.corners.reduce((sum, point) => sum + point.x, 0) / 4;
          const secondCenterX = second.corners.reduce((sum, point) => sum + point.x, 0) / 4;
          const left = firstCenterX <= secondCenterX ? first : second;
          const right = left === first ? second : first;
          const [leftTop, leftInnerTop, leftInnerBottom, leftBottom] = left.corners;
          const [rightInnerTop, rightTop, rightBottom, rightInnerBottom] = right.corners;
          const leftHeight = (Math.hypot(leftBottom.x - leftTop.x, leftBottom.y - leftTop.y) +
            Math.hypot(leftInnerBottom.x - leftInnerTop.x, leftInnerBottom.y - leftInnerTop.y)) / 2;
          const rightHeight = (Math.hypot(rightBottom.x - rightTop.x, rightBottom.y - rightTop.y) +
            Math.hypot(rightInnerBottom.x - rightInnerTop.x, rightInnerBottom.y - rightInnerTop.y)) / 2;
          const heightRatio = Math.max(leftHeight, rightHeight) / Math.max(1, Math.min(leftHeight, rightHeight));
          if (heightRatio > 1.65) continue;

          const seamDistance = (
            Math.hypot(leftInnerTop.x - rightInnerTop.x, leftInnerTop.y - rightInnerTop.y) +
            Math.hypot(leftInnerBottom.x - rightInnerBottom.x, leftInnerBottom.y - rightInnerBottom.y)
          ) / 2;
          if (seamDistance > Math.max(18, Math.min(leftHeight, rightHeight) * 0.16)) continue;

          const corners = [leftTop, rightTop, rightBottom, leftBottom];
          const topWidth = Math.hypot(rightTop.x - leftTop.x, rightTop.y - leftTop.y);
          const bottomWidth = Math.hypot(rightBottom.x - leftBottom.x, rightBottom.y - leftBottom.y);
          const height = (leftHeight + rightHeight) / 2;
          const aspect = Math.max(topWidth, bottomWidth) / Math.max(1, height);
          if (aspect < 1.05 || aspect > 2.5) continue;

          const xs = corners.map(point => point.x);
          const ys = corners.map(point => point.y);
          const x = Math.max(0, Math.floor(Math.min(...xs)));
          const y = Math.max(0, Math.floor(Math.min(...ys)));
          const rightEdge = Math.min(sourceCanvas.width, Math.ceil(Math.max(...xs)));
          const bottomEdge = Math.min(sourceCanvas.height, Math.ceil(Math.max(...ys)));
          if ((rightEdge - x) * (bottomEdge - y) <= Math.max(left.width * left.height, right.width * right.height) * 1.2) continue;

          merged.push({
            x,
            y,
            width: rightEdge - x,
            height: bottomEdge - y,
            corners,
            detected: true,
            method: 'opencv'
          });
        }
      }
      return merged;
    }

    function detectDocumentWithJscanify(sourceCanvas) {
      if (!state.scanner || !state.opencvReady) return null;

      let source;
      let contour;
      try {
        const cv = window.cv;
        const scale = Math.min(1, 640 / Math.max(sourceCanvas.width, sourceCanvas.height));
        const width = Math.max(1, Math.round(sourceCanvas.width * scale));
        const height = Math.max(1, Math.round(sourceCanvas.height * scale));
        const probe = document.createElement('canvas');
        probe.width = width;
        probe.height = height;
        const probeContext = probe.getContext('2d', { willReadFrequently: true });
        probeContext.drawImage(sourceCanvas, 0, 0, width, height);

        source = cv.matFromImageData(probeContext.getImageData(0, 0, width, height));
        contour = state.scanner.findPaperContour(source);
        if (!contour || contour.rows < 4 || Math.abs(cv.contourArea(contour)) < width * height * 0.025) return null;

        let cornerCandidates = null;
        const perimeter = cv.arcLength(contour, true);
        for (const epsilonRatio of [0.012, 0.018, 0.025, 0.035]) {
          const polygon = new cv.Mat();
          try {
            cv.approxPolyDP(contour, polygon, epsilonRatio * perimeter, true);
            if (polygon.rows === 4 && cv.isContourConvex(polygon)) {
              cornerCandidates = [];
              for (let index = 0; index < 4; index++) {
                cornerCandidates.push({ x: polygon.data32S[index * 2], y: polygon.data32S[index * 2 + 1] });
              }
              break;
            }
          } finally {
            polygon.delete();
          }
        }

        if (!cornerCandidates) {
          const detected = state.scanner.getCornerPoints(contour);
          cornerCandidates = [
            detected.topLeftCorner,
            detected.topRightCorner,
            detected.bottomRightCorner,
            detected.bottomLeftCorner
          ];
        }
        if (cornerCandidates.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
        cornerCandidates = orderDocumentCorners(cornerCandidates);
        const scaledCorners = cornerCandidates.map(point => ({ x: point.x / scale, y: point.y / scale }));
        const topWidth = Math.hypot(scaledCorners[1].x - scaledCorners[0].x, scaledCorners[1].y - scaledCorners[0].y);
        const bottomWidth = Math.hypot(scaledCorners[2].x - scaledCorners[3].x, scaledCorners[2].y - scaledCorners[3].y);
        const leftHeight = Math.hypot(scaledCorners[3].x - scaledCorners[0].x, scaledCorners[3].y - scaledCorners[0].y);
        const rightHeight = Math.hypot(scaledCorners[2].x - scaledCorners[1].x, scaledCorners[2].y - scaledCorners[1].y);
        const ratio = Math.max(topWidth, bottomWidth) / Math.max(1, Math.max(leftHeight, rightHeight));
        if (ratio < 0.22 || ratio > 4.5) return null;

        const xs = scaledCorners.map(point => point.x);
        const ys = scaledCorners.map(point => point.y);
        const x = Math.max(0, Math.floor(Math.min(...xs)));
        const y = Math.max(0, Math.floor(Math.min(...ys)));
        const right = Math.min(sourceCanvas.width, Math.ceil(Math.max(...xs)));
        const bottom = Math.min(sourceCanvas.height, Math.ceil(Math.max(...ys)));
        const edgeMarginX = sourceCanvas.width * 0.012;
        const edgeMarginY = sourceCanvas.height * 0.012;
        const areaRatio = ((right - x) * (bottom - y)) / (sourceCanvas.width * sourceCanvas.height);
        if (x <= edgeMarginX || y <= edgeMarginY || right >= sourceCanvas.width - edgeMarginX || bottom >= sourceCanvas.height - edgeMarginY || areaRatio > 0.92) {
          return null;
        }

        return {
          x,
          y,
          width: right - x,
          height: bottom - y,
          corners: scaledCorners,
          detected: true,
          method: 'jscanify'
        };
      } catch (error) {
        console.warn('jscanify không nhận diện được giấy tờ trong khung hình.', error);
        return null;
      } finally {
        if (contour && contour.delete) contour.delete();
        if (source && source.delete) source.delete();
      }
    }

    function extractDocumentWithJscanify(sourceCanvas, corners, maxEdge) {
      const points = {
        topLeftCorner: corners[0],
        topRightCorner: corners[1],
        bottomRightCorner: corners[2],
        bottomLeftCorner: corners[3]
      };
      const naturalWidth = Math.max(
        Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y),
        Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y)
      );
      const naturalHeight = Math.max(
        Math.hypot(corners[1].x - corners[2].x, corners[1].y - corners[2].y),
        Math.hypot(corners[0].x - corners[3].x, corners[0].y - corners[3].y)
      );
      const output = fitScanDimensions(naturalWidth, naturalHeight, maxEdge);
      if (window.ScanQuality && typeof sourceCanvas.getContext !== 'function') {
        return window.ScanQuality.warpPerspective(sourceCanvas, corners, output, window.cv);
      }
      const width = output.width;
      const height = output.height;
      const result = state.scanner.extractPaper(sourceCanvas, Math.round(width), Math.round(height), points);
      if (!result) throw new Error('jscanify không thể hiệu chỉnh phối cảnh tài liệu.');
      return result;
    }

    function warpDocumentPerspective(sourceCanvas, corners, maxEdge) {
      const cv = window.cv;
      const [topLeft, topRight, bottomRight, bottomLeft] = corners;
      const naturalWidth = Math.max(
        Math.hypot(bottomRight.x - bottomLeft.x, bottomRight.y - bottomLeft.y),
        Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y)
      );
      const naturalHeight = Math.max(
        Math.hypot(topRight.x - bottomRight.x, topRight.y - bottomRight.y),
        Math.hypot(topLeft.x - bottomLeft.x, topLeft.y - bottomLeft.y)
      );
      const output = fitScanDimensions(naturalWidth, naturalHeight, maxEdge);
      if (window.ScanQuality) return window.ScanQuality.warpPerspective(sourceCanvas, corners, output, cv);
      const warpedCanvas = document.createElement('canvas');
      warpedCanvas.width = output.width;
      warpedCanvas.height = output.height;

      let source;
      let sourcePoints;
      let destinationPoints;
      let transform;
      let warped;
      try {
        source = cv.matFromImageData(sourceCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sourceCanvas.width, sourceCanvas.height));
        sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
          topLeft.x, topLeft.y, topRight.x, topRight.y,
          bottomRight.x, bottomRight.y, bottomLeft.x, bottomLeft.y
        ]);
        destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
          0, 0, warpedCanvas.width - 1, 0,
          warpedCanvas.width - 1, warpedCanvas.height - 1, 0, warpedCanvas.height - 1
        ]);
        transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
        warped = new cv.Mat();
        cv.warpPerspective(source, warped, transform, new cv.Size(warpedCanvas.width, warpedCanvas.height), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
        cv.imshow(warpedCanvas, warped);
        return warpedCanvas;
      } finally {
        [source, sourcePoints, destinationPoints, transform, warped].forEach(mat => {
          if (mat && mat.delete) mat.delete();
        });
      }
    }

    function fitScanDimensions(width, height, maxEdge) {
      // Keep native pixels unless a caller explicitly requests a smaller preview.
      const scale = Number.isFinite(maxEdge) && maxEdge > 0
        ? Math.min(1, maxEdge / Math.max(width, height)) : 1;
      return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale))
      };
    }

    function prepareScan(sourceCanvas, opts = {}, mode = state.scanMode) {
      const started = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      const bounds = detectDocumentBounds(sourceCanvas, mode, opts);
      const policy = window.ScanQuality.outputPolicy(sourceCanvas, bounds, opts);
      const qualityStarted = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      const qualityReport = window.ScanQuality.assessQuality(sourceCanvas, bounds, opts);
      const qualityFinished = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      const targetLongEdge = policy.targetLongEdge;
      let target;
      if (bounds.corners && (bounds.method === 'jscanify' || bounds.method === 'opencv')) {
        target = bounds.method === 'jscanify'
          ? extractDocumentWithJscanify(sourceCanvas, bounds.corners, targetLongEdge)
          : warpDocumentPerspective(sourceCanvas, bounds.corners, targetLongEdge);
      } else {
        const output = fitScanDimensions(bounds.width, bounds.height, targetLongEdge);
        target = document.createElement('canvas');
        target.width = output.width;
        target.height = output.height;
        const context = target.getContext('2d', { willReadFrequently: true });
        context.imageSmoothingQuality = 'high';
        context.drawImage(sourceCanvas, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, target.width, target.height);
      }
      const lighting = state.opencvReady ? correctDocumentLighting(target, opts) : { applied: false, skipped: 'opencv-unavailable' };
      return { canvas: target, detected: bounds.detected, method: bounds.method,
        quality: Object.assign({}, policy.quality, { report: qualityReport }),
        dpi: policy.dpi, effectiveDpi: qualityReport.resolution.effectiveDpi, lighting,
        timings: { qualityCheckMs: qualityFinished - qualityStarted,
          documentProcessingMs: (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - started - (qualityFinished - qualityStarted) } };
    }

    function correctDocumentLighting(canvas, options = {}) {
      if (window.ScanQuality) return window.ScanQuality.correctLighting(canvas, state.opencvReady ? window.cv : null, options);
      if (!state.opencvReady) return;
      const cv = window.cv;
      const maxAnalysisEdge = 600;
      const scale = Math.min(1, maxAnalysisEdge / Math.max(canvas.width, canvas.height));
      const analysis = document.createElement('canvas');
      analysis.width = Math.max(1, Math.round(canvas.width * scale));
      analysis.height = Math.max(1, Math.round(canvas.height * scale));
      analysis.getContext('2d', { willReadFrequently: true }).drawImage(canvas, 0, 0, analysis.width, analysis.height);

      let source;
      let gray;
      let illumination;
      let fullIllumination;
      try {
        source = cv.matFromImageData(analysis.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, analysis.width, analysis.height));
        gray = new cv.Mat();
        illumination = new cv.Mat();
        fullIllumination = new cv.Mat();
        cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
        const sigma = Math.max(4, Math.min(14, Math.min(analysis.width, analysis.height) * 0.025));
        cv.GaussianBlur(gray, illumination, new cv.Size(0, 0), sigma, sigma, cv.BORDER_REPLICATE);

        const histogram = new Uint32Array(256);
        for (let index = 0; index < illumination.data.length; index++) histogram[illumination.data[index]]++;
        const percentileIndex = Math.floor(illumination.data.length * 0.7);
        let accumulated = 0;
        let reference = 200;
        for (let value = 0; value < histogram.length; value++) {
          accumulated += histogram[value];
          if (accumulated > percentileIndex) {
            reference = Math.max(150, Math.min(235, value));
            break;
          }
        }

        cv.resize(illumination, fullIllumination, new cv.Size(canvas.width, canvas.height), 0, 0, cv.INTER_LINEAR);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = image.data;
        const lightMap = fullIllumination.data;
        for (let pixel = 0, index = 0; pixel < lightMap.length; pixel++, index += 4) {
          const localLight = Math.max(32, lightMap[pixel]);
          const gain = Math.max(0.78, Math.min(1.28, Math.pow(reference / localLight, 0.65)));
          const maximumChannel = Math.max(pixels[index], pixels[index + 1], pixels[index + 2]);
          const minimumChannel = Math.min(pixels[index], pixels[index + 1], pixels[index + 2]);
          const saturation = maximumChannel ? (maximumChannel - minimumChannel) / maximumChannel : 0;
          const colorProtection = Math.max(0, 1 - saturation / 0.25);
          const safeGain = 1 + (gain - 1) * colorProtection;
          pixels[index] = Math.min(255, pixels[index] * safeGain);
          pixels[index + 1] = Math.min(255, pixels[index + 1] * safeGain);
          pixels[index + 2] = Math.min(255, pixels[index + 2] * safeGain);
        }
        context.putImageData(image, 0, 0);
      } catch (err) {
        console.warn('Lỗi khi cân bằng ánh sáng:', err);
      } finally {
        [source, gray, illumination, fullIllumination].forEach(mat => {
          if (mat && mat.delete) mat.delete();
        });
      }
    }

