/* Shared, browser-local PDF export. Recognition/source canvases are never changed. */
(function (root) {
  'use strict';

  const MAX_PDF_BYTES = 10000000;
  const TARGET_DPI = 400;
  const QUALITY_STEPS = [0.98, 0.96, 0.94, 0.92];

  function releaseCanvas(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
  }

  function createImagePreparation(source, maxWidthMm, maxHeightMm) {
    if (!source || !Number.isFinite(source.width) || !Number.isFinite(source.height) ||
        source.width < 1 || source.height < 1 || !(maxWidthMm > 0) || !(maxHeightMm > 0)) {
      throw new Error('Ảnh hoặc kích thước trang PDF không hợp lệ.');
    }
    const placementScale = Math.min(maxWidthMm / source.width, maxHeightMm / source.height);
    const widthMm = source.width * placementScale;
    const heightMm = source.height * placementScale;
    // The DPI limit follows the actual placed image size, including physical-size CCCD cards.
    // Flooring stays within the ceiling; min(1, ...) preserves every native pixel of small sources.
    const rasterScale = Math.min(1, widthMm / 25.4 * TARGET_DPI / source.width,
      heightMm / 25.4 * TARGET_DPI / source.height);
    const pixelWidth = Math.max(1, Math.floor(source.width * rasterScale));
    const pixelHeight = Math.max(1, Math.floor(source.height * rasterScale));
    const canvas = root.document.createElement('canvas');
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

  function encodeImage(prepared, quality) {
    const data = prepared.canvas.toDataURL('image/jpeg', quality);
    if (!data || !/^data:image\/jpeg;base64,/.test(data)) {
      throw new Error('Không thể nén ảnh PDF trên thiết bị này. Vui lòng thử lại với ảnh nhỏ hơn.');
    }
    return { data, widthMm: prepared.widthMm, heightMm: prepared.heightMm,
      pixelWidth: prepared.pixelWidth, pixelHeight: prepared.pixelHeight };
  }

  function prepareImage(source, maxWidthMm, maxHeightMm, quality) {
    const prepared = createImagePreparation(source, maxWidthMm, maxHeightMm);
    try {
      return encodeImage(prepared, quality === undefined ? QUALITY_STEPS[0] : quality);
    } finally {
      releaseCanvas(prepared.canvas);
    }
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
      // jsPDF's standard page dimensions can differ by a small rounding fraction of a mm.
      const fit = Math.min(1, pageWidth / image.widthMm, pageHeight / image.heightMm);
      const widthMm = image.widthMm * fit;
      const heightMm = image.heightMm * fit;
      pdf.addImage(image.data, 'JPEG', (pageWidth - widthMm) / 2,
        (pageHeight - heightMm) / 2, widthMm, heightMm);
    });
    const buffer = pdf.output('arraybuffer');
    if (!buffer || !Number.isInteger(buffer.byteLength) || buffer.byteLength <= 0) {
      throw new Error('Không thể tạo tệp PDF hợp lệ. Vui lòng thử lại.');
    }
    return buffer;
  }

  function dataUriFromBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    // A multiple of three permits independent Base64 chunks without intermediate padding.
    const chunkSize = 24576;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      chunks.push(root.btoa(String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize))));
    }
    return 'data:application/pdf;base64,' + chunks.join('');
  }

  function makePart(pages, buffer) {
    // Always measure the final PDF, including PDF objects/metadata rather than JPEG or Base64 lengths.
    if (buffer.byteLength > MAX_PDF_BYTES) throw new Error('Tệp PDF vượt quá giới hạn 10 MB.');
    return { dataUri: dataUriFromBuffer(buffer), byteLength: buffer.byteLength,
      pageCount: pages.length, quality: Math.min.apply(null, pages.map(function (page) { return page.quality; })),
      dpi: TARGET_DPI };
  }

  async function exportPdfParts(scans, options) {
    if (!Array.isArray(scans) || !scans.length) throw new Error('Không có ảnh để tạo PDF.');
    options = options || {};
    const parts = [];
    let currentPages = [];
    let currentBuffer = null;
    function progress(stage, pageIndex, quality) {
      if (typeof options.onProgress === 'function') options.onProgress({ stage, pageIndex,
        totalPages: scans.length, partCount: parts.length + 1, quality });
    }

    for (let index = 0; index < scans.length; index++) {
      await new Promise(function (resolve) { root.setTimeout(resolve, 0); });
      const item = scans[index];
      const source = item && (options.original ? item.originalCanvas : item.canvas);
      if (!source) throw new Error(options.original ? 'Thiếu ảnh gốc để tạo bản sao dự phòng.' : 'Thiếu ảnh để tạo PDF.');
      const layout = pageLayout(item, source);
      const prepared = createImagePreparation(source, layout.maxWidthMm, layout.maxHeightMm);
      try {
        let accepted = false;
        for (let step = 0; step < QUALITY_STEPS.length; step++) {
          const quality = QUALITY_STEPS[step];
          progress('encode', index + 1, quality);
          // Cache each page's JPEG; PDF regrouping never recompresses a previously accepted page.
          const page = { format: layout.format, orientation: layout.orientation,
            quality, image: encodeImage(prepared, quality) };
          const candidatePages = currentPages.concat([page]);
          progress('assemble', index + 1, quality);
          const candidateBuffer = buildPdfBuffer(candidatePages);
          if (candidateBuffer.byteLength <= MAX_PDF_BYTES) {
            currentPages = candidatePages;
            currentBuffer = candidateBuffer;
            accepted = true;
            break;
          }
          const singleBuffer = currentPages.length ? buildPdfBuffer([page]) : candidateBuffer;
          if (singleBuffer.byteLength <= MAX_PDF_BYTES) {
            parts.push(makePart(currentPages, currentBuffer));
            currentPages = [page];
            currentBuffer = singleBuffer;
            accepted = true;
            break;
          }
          // Only unusually large individual pages use the quality ladder; normal pages stay at .98.
          await new Promise(function (resolve) { root.setTimeout(resolve, 0); });
        }
        if (!accepted) throw new Error('Trang ' + (index + 1) +
          ' vẫn vượt 10 MB ở mức tối đa 400 dpi và chất lượng JPEG 92%. ' +
          'Vui lòng chụp lại trang rõ nét, ít nhiễu hoặc chia nội dung thành các ảnh riêng.');
      } finally {
        releaseCanvas(prepared.canvas);
      }
    }
    if (currentPages.length) parts.push(makePart(currentPages, currentBuffer));
    return parts;
  }

  root.DocumentPdfExporter = { MAX_PDF_BYTES, TARGET_DPI,
    QUALITY_STEPS: QUALITY_STEPS.slice(), prepareImage, exportPdfParts };
})(typeof window !== 'undefined' ? window : self);
