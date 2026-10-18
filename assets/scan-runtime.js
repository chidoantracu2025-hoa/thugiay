/* Per-tab camera/image resources. Originals stay compressed until a task needs pixels. */
(function (root) {
  'use strict';

  function releaseCanvas(canvas) {
    if (canvas && typeof canvas.getContext !== 'function' && typeof canvas.close === 'function') { canvas.close(); return; }
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }

  function canvasBlob(canvas, quality) {
    if (typeof canvas.convertToBlob === 'function') {
      return canvas.convertToBlob({ type: 'image/jpeg', quality: quality === undefined ? .98 : quality });
    }
    return new Promise(function (resolve, reject) {
      if (!canvas.toBlob) { reject(new Error('Trình duyệt chưa hỗ trợ lưu ảnh tiết kiệm bộ nhớ.')); return; }
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('Không đủ bộ nhớ để nén ảnh. Ảnh hiện tại vẫn được giữ.'));
      }, 'image/jpeg', quality === undefined ? .98 : quality);
    });
  }

  async function decodeBlob(blob) {
    if (typeof root.createImageBitmap === 'function') {
      try { return await root.createImageBitmap(blob, { imageOrientation: 'from-image' }); }
      catch (_) { return root.createImageBitmap(blob); }
    }
    return new Promise(function (resolve, reject) {
      const url = root.URL.createObjectURL(blob);
      const image = new root.Image();
      image.onload = function () { root.URL.revokeObjectURL(url); resolve(image); };
      image.onerror = function () { root.URL.revokeObjectURL(url); reject(new Error('Không đọc được ảnh gốc.')); };
      image.src = url;
    });
  }

  async function loadSource(item, original) {
    if (!original && item.canvas) return { canvas: item.canvas };
    if (original && item.originalCanvas) return { canvas: item.originalCanvas };
    const blob = original ? item.originalBlob : item.processedBlob;
    if (!blob) throw new Error(original ? 'Thiếu ảnh gốc để tạo bản sao dự phòng.' : 'Thiếu ảnh đã xử lý để tạo PDF.');
    const bitmap = await decodeBlob(blob);
    if (typeof bitmap.close === 'function') {
      // QR probes and PDF resampling both accept ImageBitmap directly; avoid a full-size canvas copy.
      return { canvas: bitmap, release: function () { bitmap.close(); } };
    }
    const canvas = root.document.createElement('canvas');
    try {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Thiết bị không đủ bộ nhớ để đọc ảnh gốc.');
      context.drawImage(bitmap, 0, 0);
      return { canvas, release: function () { releaseCanvas(canvas); } };
    } catch (error) {
      releaseCanvas(canvas);
      throw error;
    } finally { if (bitmap.close) bitmap.close(); }
  }

  async function previewUrl(source) {
    const scale = Math.min(1, 1000 / Math.max(source.width, source.height));
    const canvas = root.document.createElement('canvas');
    try {
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      return root.URL.createObjectURL(await canvasBlob(canvas, .88));
    } finally { releaseCanvas(canvas); }
  }

  async function storeOriginal(item, source, originalBlob) {
    item.revision = item.revision || 1;
    item.originalWidth = source.width;
    item.originalHeight = source.height;
    let originalPreview;
    let processedPreview;
    try {
      // Preserve actual camera/upload bytes; encoding is only necessary for a video-frame fallback.
      item.originalBlob = originalBlob || await canvasBlob(source, .98);
      originalPreview = await previewUrl(source);
      processedPreview = await previewUrl(item.canvas);
      item.originalPreviewUrl = originalPreview;
      item.processedPreviewUrl = processedPreview;
    } catch (error) {
      if (originalPreview) root.URL.revokeObjectURL(originalPreview);
      if (processedPreview) root.URL.revokeObjectURL(processedPreview);
      // Keep a usable original on browsers whose JPEG encoder fails.
      item.originalCanvas = source;
      item.storageWarning = 'Ảnh gốc được giữ trong bộ nhớ vì chưa nén được trên trình duyệt này.';
    }
    if (item.type === 'document' && item.canvas) await storeProcessed(item);
    return item;
  }

  async function storeProcessed(item) {
    const canvas = item.canvas;
    const width = canvas.width, height = canvas.height;
    const qualitySteps = [.96, .94, .92];
    // Leave ample room for one-page PDF objects. The exporter still validates the exact final PDF size.
    const jpegBudget = 10000000 - 73728;
    let blob, quality;
    try {
      const context = canvas.getContext('2d');
      context.save();
      try {
        context.globalCompositeOperation = 'destination-over';
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
      } finally { context.restore(); }
      for (let step = 0; step < qualitySteps.length; step++) {
        quality = qualitySteps[step];
        blob = await canvasBlob(canvas, quality);
        if (!blob || blob.type !== 'image/jpeg' || !(blob.size > 0)) throw new Error('Không tạo được ảnh JPEG hợp lệ.');
        if (blob.size <= jpegBudget) break;
      }
      item.processedBlob = blob;
      item.processedWidth = width;
      item.processedHeight = height;
      item.processedDpi = Number(item.dpi || item.processingQuality && item.processingQuality.dpi) === 300 ? 300 : 400;
      item.processedQuality = quality;
      item.processedCanonical = true;
      // A preview failure can retain the same object as the original; never destroy that fallback.
      if (canvas !== item.originalCanvas) releaseCanvas(canvas);
      item.canvas = null;
    } catch (error) {
      const message = 'Ảnh đã xử lý được giữ trong bộ nhớ vì chưa nén được trên trình duyệt này.';
      item.storageWarning = item.storageWarning ? item.storageWarning + ' ' + message : message;
    }
  }

  function disposeItem(item) {
    if (!item) return;
    [item.originalPreviewUrl, item.processedPreviewUrl].forEach(function (url) {
      if (url) root.URL.revokeObjectURL(url);
    });
    releaseCanvas(item.originalCanvas);
    releaseCanvas(item.canvas);
    item.originalBlob = null;
    item.processedBlob = null;
    if (root.DocumentPdfExporter && root.DocumentPdfExporter.clearCache) root.DocumentPdfExporter.clearCache(item);
  }

  function choosePhotoSettings(capabilities, type, dpi, profile) {
    const width = capabilities && capabilities.imageWidth;
    const height = capabilities && capabilities.imageHeight;
    if (!width || !height || !(width.max > 0) || !(height.max > 0)) return {};
    const documentPhoto = type === 'document';
    // A3 at 400 dpi plus camera aspect/crop margin; do not force a 48/108 MP sensor mode.
    const qualityMode = profile === 'quality';
    const pixelLimit = documentPhoto ? (qualityMode && dpi !== 300 ? 42000000 : 26000000) : 8000000;
    const edgeLimit = documentPhoto ? (qualityMode && dpi !== 300 ? 8000 : 6400) : 3600;
    const scale = Math.min(1, Math.sqrt(pixelLimit / (width.max * height.max)),
      edgeLimit / Math.max(width.max, height.max));
    function fit(range) {
      const step = range.step > 0 ? range.step : 1;
      const minimum = range.min > 0 ? range.min : 1;
      return Math.min(range.max, Math.max(minimum,
        minimum + Math.floor((range.max * scale - minimum) / step) * step));
    }
    return { imageWidth: fit(width), imageHeight: fit(height) };
  }

  function revisionOf(item) { return item.revision || item.pdfRevision || item.processingRevision || 0; }
  function sameScans(entry, scans, original, variant) {
    return entry.original === original && entry.variant === (variant || '') && entry.items.length === scans.length &&
      entry.items.every(function (item, index) {
        const current = scans[index];
        return item === current && entry.revisions[index] === revisionOf(current) &&
          entry.sources[index] === (original ? current.originalBlob || current.originalCanvas : current.processedBlob || current.canvas) &&
          entry.dpis[index] === (current.dpi || current.processingQuality && current.processingQuality.dpi || current.processedDpi || 400) &&
          entry.types[index] === current.type;
      });
  }

  async function cachedPdf(state, scans, original, produce, variant) {
    const entries = state.pdfCache || (state.pdfCache = []);
    const cached = entries.find(function (entry) { return sameScans(entry, scans, original, variant); });
    if (cached) return cached.parts;
    const parts = await produce();
    const byteLength = parts.reduce(function (sum, part) { return sum + part.byteLength; }, 0);
    if (byteLength <= 24000000) {
      while (entries.length && entries.reduce(function (sum, entry) { return sum + entry.byteLength; }, 0) + byteLength > 24000000) entries.shift();
      entries.push({ items: scans.slice(), revisions: scans.map(revisionOf),
        dpis: scans.map(function (item) { return item.dpi || item.processingQuality && item.processingQuality.dpi || item.processedDpi || 400; }),
        types: scans.map(function (item) { return item.type; }),
        sources: scans.map(function (item) { return original ? item.originalBlob || item.originalCanvas : item.processedBlob || item.canvas; }),
        original, variant: variant || '', parts, byteLength });
    }
    return parts;
  }

  root.ScanRuntime = { canvasBlob, decodeBlob, loadSource, storeOriginal, previewUrl,
    releaseCanvas, disposeItem, choosePhotoSettings, cachedPdf };
})(typeof window !== 'undefined' ? window : self);
