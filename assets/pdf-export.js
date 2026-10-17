/* Shared, browser-local PDF export. Recognition/source images are never changed. */
(function (root) {
  'use strict';

  const MAX_PDF_BYTES = 10000000;
  const TARGET_DPI = 400;
  const QUALITY_STEPS = [0.96, 0.94, 0.92];
  // JPEG bytes embed directly. Reserve space for PDF metadata, then check the actual final bytes.
  const PDF_BASE_RESERVE = 65536;
  const PDF_PAGE_RESERVE = 8192;
  const CACHE_BYTES = 24 * 1024 * 1024;
  let imageCache = new WeakMap();
  let cacheRecords = [];
  let cachedBytes = 0;
  let cacheClock = 0;
  let imageClock = 0;

  function releaseCanvas(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
  }

  function targetDpi(item) {
    const value = Number(item && (item.dpi || item.processingQuality && item.processingQuality.dpi || item.processedDpi));
    return value === 300 ? 300 : TARGET_DPI;
  }

  function createImagePreparation(source, maxWidthMm, maxHeightMm, dpi, asynchronous) {
    if (!source || !Number.isFinite(source.width) || !Number.isFinite(source.height) ||
        source.width < 1 || source.height < 1 || !(maxWidthMm > 0) || !(maxHeightMm > 0)) {
      throw new Error('Ảnh hoặc kích thước trang PDF không hợp lệ.');
    }
    const placementScale = Math.min(maxWidthMm / source.width, maxHeightMm / source.height);
    const widthMm = source.width * placementScale;
    const heightMm = source.height * placementScale;
    const rasterScale = Math.min(1, widthMm / 25.4 * dpi / source.width,
      heightMm / 25.4 * dpi / source.height);
    const pixelWidth = Math.max(1, Math.floor(source.width * rasterScale));
    const pixelHeight = Math.max(1, Math.floor(source.height * rasterScale));
    const canvas = asynchronous && typeof root.OffscreenCanvas === 'function' ?
      new root.OffscreenCanvas(pixelWidth, pixelHeight) : root.document.createElement('canvas');
    try {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Thiết bị không đủ bộ nhớ để tạo ảnh PDF.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, pixelWidth, pixelHeight);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, pixelWidth, pixelHeight);
      return { canvas, widthMm, heightMm, pixelWidth, pixelHeight };
    } catch (error) {
      releaseCanvas(canvas);
      throw error;
    }
  }

  function imageResult(prepared, data) {
    return { data, widthMm: prepared.widthMm, heightMm: prepared.heightMm,
      pixelWidth: prepared.pixelWidth, pixelHeight: prepared.pixelHeight };
  }

  function encodeImage(prepared, quality) {
    const data = prepared.canvas.toDataURL('image/jpeg', quality);
    if (!data || !/^data:image\/jpeg;base64,/.test(data)) {
      throw new Error('Không thể nén ảnh PDF trên thiết bị này. Vui lòng thử lại với ảnh nhỏ hơn.');
    }
    return imageResult(prepared, data);
  }

  // Compatibility helper; saving uses asynchronous Blob encoding below.
  function prepareImage(source, maxWidthMm, maxHeightMm, quality, dpi) {
    const prepared = createImagePreparation(source, maxWidthMm, maxHeightMm, dpi === 300 ? 300 : TARGET_DPI, false);
    try { return encodeImage(prepared, quality === undefined ? QUALITY_STEPS[0] : quality); }
    finally { releaseCanvas(prepared.canvas); }
  }

  function blobBuffer(blob) {
    if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
    return new Promise(function (resolve, reject) {
      const reader = new root.FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('Không thể đọc ảnh đã nén.')); };
      reader.readAsArrayBuffer(blob);
    });
  }

  function bytesFromDataUri(data) {
    const binary = root.atob(data.slice(data.indexOf(',') + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function encodeImageAsync(prepared, quality) {
    let blob;
    if (typeof prepared.canvas.convertToBlob === 'function') {
      blob = await prepared.canvas.convertToBlob({ type: 'image/jpeg', quality });
    } else if (typeof prepared.canvas.toBlob === 'function') {
      blob = await new Promise(function (resolve, reject) {
        try { prepared.canvas.toBlob(resolve, 'image/jpeg', quality); }
        catch (error) { reject(error); }
      });
    } else {
      const image = encodeImage(prepared, quality);
      image.data = bytesFromDataUri(image.data);
      image.byteLength = image.data.byteLength;
      image.pdfAlias = 'scan_image_' + (++imageClock);
      return image;
    }
    if (!blob || blob.type && blob.type !== 'image/jpeg' || !blob.size) {
      throw new Error('Không thể nén ảnh PDF trên thiết bị này. Vui lòng thử lại với ảnh nhỏ hơn.');
    }
    const bytes = new Uint8Array(await blobBuffer(blob));
    if (!bytes.byteLength) throw new Error('Ảnh PDF đã nén bị rỗng.');
    const image = imageResult(prepared, bytes);
    image.byteLength = bytes.byteLength;
    image.pdfAlias = 'scan_image_' + (++imageClock);
    return image;
  }

  function pageLayout(item, source) {
    const isDocument = item.type === 'document';
    const landscape = isDocument && source.width > source.height;
    return {
      format: isDocument ? 'a3' : 'a4',
      orientation: landscape ? 'landscape' : 'portrait',
      maxWidthMm: isDocument ? (landscape ? 420 : 297) : (source.width >= source.height ? 85.6 : 53.98),
      maxHeightMm: isDocument ? (landscape ? 297 : 420) : (source.width >= source.height ? 53.98 : 85.6)
    };
  }

  function forgetRecord(record) {
    if (!record.image) return;
    cachedBytes -= record.image.byteLength;
    record.image = null;
  }

  function clearCache(item) {
    if (!item) {
      imageCache = new WeakMap();
      cacheRecords = [];
      cachedBytes = 0;
      return;
    }
    const groups = imageCache.get(item);
    if (groups) Object.keys(groups).forEach(function (key) { groups[key].images.forEach(forgetRecord); });
    imageCache.delete(item);
    cacheRecords = cacheRecords.filter(function (record) { return Boolean(record.image); });
  }

  function cacheFor(item, options, dpi) {
    const original = Boolean(options.original);
    const key = original ? 'original' : 'processed';
    const source = original ? item.originalBlob || item.originalCanvas : item.processedBlob || item.canvas;
    const revision = typeof options.getRevision === 'function' ? options.getRevision(item, original) :
      [item.revision || 0, item.pdfRevision || 0, item.processingRevision || 0].join(':');
    const dimensions = source && Number.isFinite(source.width) ? source.width + 'x' + source.height :
      !original && item.processedBlob ? [item.processedWidth, item.processedHeight, item.processedQuality,
        item.processedCanonical, item.processedEncoding].join(':') : '';
    let groups = imageCache.get(item);
    if (!groups) { groups = {}; imageCache.set(item, groups); }
    let entry = groups[key];
    if (!entry || entry.source !== source || entry.revision !== revision || entry.dimensions !== dimensions ||
        entry.dpi !== dpi || entry.type !== item.type) {
      if (entry) entry.images.forEach(forgetRecord);
      entry = { source, revision, dimensions, dpi, type: item.type, layout: null, images: new Map() };
      groups[key] = entry;
    }
    return entry;
  }

  function cachedImage(entry, quality) {
    const record = entry.images.get(quality);
    if (!record || !record.image) return null;
    record.lastUsed = ++cacheClock;
    return record.image;
  }

  function rememberImage(entry, quality, image) {
    if (image.byteLength > CACHE_BYTES) return;
    const previous = entry.images.get(quality);
    if (previous) forgetRecord(previous);
    const record = { image, lastUsed: ++cacheClock };
    entry.images.set(quality, record);
    cacheRecords.push(record);
    cachedBytes += image.byteLength;
    cacheRecords = cacheRecords.filter(function (value) { return Boolean(value.image); });
    while (cachedBytes > CACHE_BYTES || cacheRecords.length > 64) {
      let oldest = 0;
      for (let index = 1; index < cacheRecords.length; index++) {
        if (cacheRecords[index].lastUsed < cacheRecords[oldest].lastUsed) oldest = index;
      }
      forgetRecord(cacheRecords[oldest]);
      cacheRecords.splice(oldest, 1);
    }
  }

  function buildPdfBuffer(pages) {
    if (!root.jspdf || typeof root.jspdf.jsPDF !== 'function') {
      throw new Error('Chưa tải được thư viện tạo PDF. Vui lòng tải lại trang.');
    }
    let pdf;
    pages.forEach(function (page) {
      if (!pdf) pdf = new root.jspdf.jsPDF({ orientation: page.orientation,
        unit: 'mm', format: page.format, compress: true });
      else pdf.addPage(page.format, page.orientation);
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const image = page.image;
      const fit = Math.min(1, pageWidth / image.widthMm, pageHeight / image.heightMm);
      const widthMm = image.widthMm * fit;
      const heightMm = image.heightMm * fit;
      // Explicit aliases avoid jsPDF hashing millions of JPEG bytes and prevent its partial
      // Uint8Array hash from confusing distinct pages that share the same leading image data.
      pdf.addImage(image.data, 'JPEG', (pageWidth - widthMm) / 2,
        (pageHeight - heightMm) / 2, widthMm, heightMm, image.pdfAlias);
    });
    const buffer = pdf.output('arraybuffer');
    if (!buffer || !Number.isInteger(buffer.byteLength) || buffer.byteLength <= 0) {
      throw new Error('Không thể tạo tệp PDF hợp lệ. Vui lòng thử lại.');
    }
    return buffer;
  }

  function dataUriFromBuffer(buffer) {
    if (typeof root.FileReader === 'function' && typeof root.Blob === 'function') {
      return new Promise(function (resolve, reject) {
        const reader = new root.FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { reject(reader.error || new Error('Không thể đọc tệp PDF.')); };
        reader.readAsDataURL(new root.Blob([buffer], { type: 'application/pdf' }));
      });
    }
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    for (let index = 0; index < bytes.length; index += 24576) {
      chunks.push(root.btoa(String.fromCharCode.apply(null, bytes.subarray(index, index + 24576))));
    }
    return Promise.resolve('data:application/pdf;base64,' + chunks.join(''));
  }

  async function makePart(pages, buffer) {
    if (buffer.byteLength > MAX_PDF_BYTES) throw new Error('Tệp PDF vượt quá giới hạn 10 MB.');
    return { dataUri: await dataUriFromBuffer(buffer), byteLength: buffer.byteLength,
      pageCount: pages.length, quality: Math.min.apply(null, pages.map(function (page) { return page.quality; })),
      dpi: Math.max.apply(null, pages.map(function (page) { return page.dpi; })) };
  }

  function estimatedBytes(pages) {
    return PDF_BASE_RESERVE + pages.reduce(function (sum, page) {
      return sum + PDF_PAGE_RESERVE + page.image.byteLength;
    }, 0);
  }

  function canonicalImage(item, dpi) {
    const blob = item.processedBlob;
    const quality = Number(item.processedQuality);
    const width = Number(item.processedWidth), height = Number(item.processedHeight);
    // Only canvas-produced JPEGs have canonical orientation. Camera originals can carry EXIF
    // rotation and must always follow the normal decode path.
    if (!blob || blob.type !== 'image/jpeg' || !(blob.size > 0) ||
        !(item.processedCanonical === true || item.processedEncoding === 'canonical-jpeg') ||
        !(quality >= .92 && quality <= 1) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
    const layout = pageLayout(item, { width, height });
    const placement = Math.min(layout.maxWidthMm / width, layout.maxHeightMm / height);
    const widthMm = width * placement, heightMm = height * placement;
    // A subsequent 400 -> 300 selection cannot reuse a larger JPEG unchanged.
    if (width > widthMm / 25.4 * dpi + 1e-6 || height > heightMm / 25.4 * dpi + 1e-6) return null;
    return { blob, quality, layout, widthMm, heightMm, pixelWidth: width, pixelHeight: height };
  }

  function retryStepAfter(quality) {
    for (let step = 0; step < QUALITY_STEPS.length; step++) {
      if (QUALITY_STEPS[step] < quality - 1e-8) return step;
    }
    return QUALITY_STEPS.length;
  }

  async function exportPdfParts(scans, options) {
    if (!Array.isArray(scans) || !scans.length) throw new Error('Không có ảnh để tạo PDF.');
    options = options || {};
    const parts = [];
    let currentPages = [];
    function progress(stage, pageIndex, quality) {
      if (typeof options.onProgress === 'function') options.onProgress({ stage, pageIndex,
        totalPages: scans.length, partCount: parts.length + 1, quality });
    }
    function yieldToInterface() {
      return new Promise(function (resolve) { root.setTimeout(resolve, 0); });
    }

    async function createPage(item, index, firstStep, forceExact) {
      if (!item || typeof item !== 'object') throw new Error('Thiếu ảnh để tạo PDF.');
      const dpi = targetDpi(item);
      const entry = cacheFor(item, options, dpi);
      let loaded = null;
      let source = null;
      let prepared = null;
      try {
        let startStep = firstStep || 0;
        const canonical = !options.original && !forceExact && startStep === 0 ? canonicalImage(item, dpi) : null;
        if (canonical) {
          progress('encode', index + 1, canonical.quality);
          entry.layout = canonical.layout;
          let image = cachedImage(entry, 'canonical');
          if (!image) {
            const bytes = new Uint8Array(await blobBuffer(canonical.blob));
            if (!bytes.byteLength) throw new Error('Ảnh PDF đã nén bị rỗng.');
            image = imageResult(canonical, bytes);
            image.byteLength = bytes.byteLength;
            image.pdfAlias = 'scan_image_' + (++imageClock);
            rememberImage(entry, 'canonical', image);
          }
          const nextStep = retryStepAfter(canonical.quality);
          const page = { format: entry.layout.format, orientation: entry.layout.orientation,
            quality: canonical.quality, dpi, image, item, index, step: nextStep - 1 };
          if (estimatedBytes([page]) < MAX_PDF_BYTES) return page;
          if (image.byteLength <= MAX_PDF_BYTES) {
            progress('assemble', index + 1, canonical.quality);
            const buffer = buildPdfBuffer([page]);
            if (buffer.byteLength <= MAX_PDF_BYTES) { page.singleBuffer = buffer; return page; }
          }
          startStep = nextStep;
        }
        for (let step = startStep; step < QUALITY_STEPS.length; step++) {
          const quality = QUALITY_STEPS[step];
          progress('encode', index + 1, quality);
          let image = cachedImage(entry, quality);
          if (!image) {
            if (!source) {
              loaded = typeof options.loadSource === 'function' ? await options.loadSource(item, Boolean(options.original)) :
                { canvas: options.original ? item.originalCanvas : item.canvas };
              source = loaded && (loaded.canvas || loaded);
              if (!source) throw new Error(options.original ? 'Thiếu ảnh gốc để tạo bản sao dự phòng.' : 'Thiếu ảnh để tạo PDF.');
              entry.layout = pageLayout(item, source);
            }
            if (!prepared) prepared = createImagePreparation(source, entry.layout.maxWidthMm,
              entry.layout.maxHeightMm, dpi, true);
            image = await encodeImageAsync(prepared, quality);
            rememberImage(entry, quality, image);
          }
          const layout = entry.layout;
          const sourceQuality = !options.original && item.processedBlob ? Number(item.processedQuality) : 1;
          const actualQuality = sourceQuality > 0 && sourceQuality <= 1 ? Math.min(sourceQuality, quality) : quality;
          const page = { format: layout.format, orientation: layout.orientation, quality: actualQuality, dpi, image, item, index, step };
          if (forceExact || estimatedBytes([page]) >= MAX_PDF_BYTES) {
            // jsPDF embeds the JPEG stream verbatim. A JPEG already larger than the file cap
            // cannot fit even before PDF metadata, so avoid allocating another oversized PDF.
            if (image.byteLength > MAX_PDF_BYTES) { await yieldToInterface(); continue; }
            progress('assemble', index + 1, quality);
            const buffer = buildPdfBuffer([page]);
            if (buffer.byteLength > MAX_PDF_BYTES) { await yieldToInterface(); continue; }
            page.singleBuffer = buffer;
          }
          return page;
        }
        throw new Error('Trang ' + (index + 1) + ' vẫn vượt 10 MB ở mức tối đa ' + dpi +
          ' dpi và chất lượng JPEG 92%. Vui lòng chụp lại trang rõ nét, ít nhiễu hoặc chia nội dung thành các ảnh riêng.');
      } finally {
        if (prepared) releaseCanvas(prepared.canvas);
        if (loaded && typeof loaded.release === 'function') loaded.release();
      }
    }

    async function flushPages(pages) {
      if (!pages.length) return;
      await yieldToInterface();
      progress('assemble', pages[pages.length - 1].index + 1, pages[pages.length - 1].quality);
      let buffer = pages.length === 1 && pages[0].singleBuffer || buildPdfBuffer(pages);
      if (buffer.byteLength <= MAX_PDF_BYTES) {
        parts.push(await makePart(pages, buffer));
        return;
      }
      // If a different jsPDF version exceeds the reserve, split without recompressing pages.
      buffer = null;
      if (pages.length > 1) {
        const middle = Math.ceil(pages.length / 2);
        await flushPages(pages.slice(0, middle));
        await flushPages(pages.slice(middle));
        return;
      }
      const page = pages[0];
      const replacement = await createPage(page.item, page.index, page.step + 1, true);
      parts.push(await makePart([replacement], replacement.singleBuffer));
    }

    for (let index = 0; index < scans.length; index++) {
      await yieldToInterface();
      const page = await createPage(scans[index], index, 0, false);
      if (currentPages.length && estimatedBytes(currentPages.concat([page])) > MAX_PDF_BYTES) {
        await flushPages(currentPages);
        currentPages = [];
      }
      currentPages.push(page);
      if (page.singleBuffer) {
        await flushPages(currentPages);
        currentPages = [];
      }
    }
    await flushPages(currentPages);
    return parts;
  }

  root.DocumentPdfExporter = { MAX_PDF_BYTES, TARGET_DPI,
    QUALITY_STEPS: QUALITY_STEPS.slice(), prepareImage, exportPdfParts, clearCache, reset: clearCache };
})(typeof window !== 'undefined' ? window : self);
