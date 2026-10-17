# Local document scanning assets

`DaiAn.html`, `HamGiang.html`, `LongHiep.html`, `LuuNghiepAnh.html`,
`TapSon.html` and `TraCu.html` use these files for on-device OpenCV scanning,
QR decoding, OCR and PDF generation. Deploy the entire `assets/` directory
alongside the HTML pages, `opencv.js` and `jscanify.min.js`. Serve over HTTPS (or localhost)
for camera and Worker support; opening a file directly is not the supported setup.

- QR: jsQR 1.4.0, executed in `cccd-qr-worker.js`.
- PDF: jsPDF 2.5.1.
- OCR: Tesseract.js 5.1.1, Tesseract.js-core 5.1.1 and local English data.
- Scanning: `document-scan-worker.js` uses the repository's OpenCV/jscanify.
  Browsers without OffscreenCanvas use the main-thread compatibility path.
- Sessions: `scan-session.js` creates a distinct session and dedicated scan/QR
  Workers for each page instance. Each client queues its own requests, captures
  detection settings per image, and rejects replies with another session or
  request ID. OCR has its own queue per page instance. Settings use page-specific
  `sessionStorage` with an in-memory fallback, so changing one tab's mode or API
  URL does not change another tab's recognition settings. Existing saved settings
  are read once for migration. Scan images remain in the current tab's memory.
- Additional A4/A3 detection: `a4-document-detector.js` is shared by all six
  pages and the scan Worker. It finds light paper regions at adaptive thresholds,
  closes small crease shadows and fits four enclosing corners to an uneven
  outline. It also runs in the camera preview. Validated corners take priority
  over a color-fallback box covering the same paper. CCCD processing and the
  selected fallback-only mode retain their existing detectors.
  Perspective correction adjusts the overall page; it does not flatten every
  local wrinkle. The existing lighting correction reduces crease shadows.
- Dependencies are stored locally; no external recognition API is called.
  Existing Drive/Sheet saving still uploads the resulting PDF and record to Google.

Scan processing retains the native source/crop resolution. `pdf-export.js`
exports JPEG images at quality 0.98, downsampling only when their placed size
would exceed 400 dpi; it never enlarges smaller sources. Each final PDF is
measured as binary data and capped at 10,000,000 bytes, including PDF overhead.
Long documents split in page order rather than lowering the quality of all pages.
Only a page that exceeds the cap on its own retries JPEG quality 0.96, 0.94 and
0.92, always encoding from the same export canvas. If it still cannot fit, saving
stops with a clear error and keeps the scans for retry. The combined backup uses
images before geometric and lighting correction with the same export compression;
it is not a byte-exact or lossless archive. A3 orientation follows the image;
cards still fit inside 85.6 x 53.98 mm (swapped for portrait) on A4.
Thumbnail previews remain smaller JPEGs and are never used to generate PDFs.
Camera capture requests the maximum available still-photo dimensions and uses
the native video frame if still capture is unavailable. Detection analysis and
lighting estimation use small probes without resizing the recognition image.
Readability still depends on source focus, lighting and resolution; device memory
and Google service limits still apply to very large files.

The browser prepares all PDF groups before making a save request. `code.gs`
also validates every file's decoded size before any upload or sheet mutation.
A single PDF uses the existing file link. Multiple parts of one kind use a fresh
shared Drive folder, whose link goes into the same original/GCN/CCCD link field.
Parts have numbered filenames, and simultaneous saves never reuse a folder.
Deploy the updated Apps Script before saving split documents: the browser checks
its multipart capability and stops if the deployed API is older. A partial Drive
failure is reported explicitly and retains the previous link for the failed group;
the page keeps the row selected so retry updates the same record.

`code.gs` uploads files independently, then uses a short script lock to read the
latest row, allocate its STT, write it, and return the exact saved row index.
Status/note edits use the same lock; Drive uploads do not hold it. Deploy the
updated Apps Script as well as all six HTML pages and the `assets/` directory
to activate both the browser and server concurrency improvements.

QR parsing accepts a pipe-separated CCCD payload with a twelve-digit first
field and a nonempty name field; it does not treat URLs or arbitrary digit
strings as identity numbers. QR decoding is not identity authentication.
OCR is a fallback and results should be checked before saving.

Licenses are in `vendor/licenses/`. Source projects:
https://github.com/cozmo/jsQR
https://github.com/parallax/jsPDF
https://github.com/naptha/tesseract.js
https://github.com/naptha/tesseract.js-core
English language data: https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz

Validation from the repository root: `node tests/pdf-export.test.js`,
`node tests/pdf-save.test.js`, `node tests/land-scan.test.js`,
`node tests/scan-session.test.js` and `node tests/server-concurrency.test.js`.
For image detection, serve the repository with `python3 -m http.server 8765`
and open `http://localhost:8765/tests/document-detection.html`. The browser
harness checks generated flat, wrinkled, skewed and rotated sheets, background
rejection, CCCD exclusion, two-page spreads, and Worker/main-thread agreement.
Add `?sample=test.jpg` to check the local sample as well.
Real camera, lighting, card formats and browser Worker behavior still require
validation on the target devices.

# Default report sources

For `baocao.html`, enter each commune's default public Google Sheet or published
CSV link in `report-config.js` under its page ID (`HamGiang`, `TraCu`, `LongHiep`,
`TapSon`, `LuuNghiepAnh`, `DaiAn`). If one spreadsheet contains multiple commune
tabs, use the appropriate `gid` in each link. Deploy this configuration file
alongside `report-dashboard.js` and the HTML page. No sample URL is enabled.
The dashboard automatically loads the six effective sources when it opens.

A visitor can override a commune's source in the configuration panel; this
preference applies only to their browser. “Dùng link mặc định” removes that
commune's override and immediately reloads the deployed default. Empty previous
preferences also use the default. Browsers that cannot store preferences still
use the defaults and can change sources for the current visit.

Validation: `node tests/report-dashboard.test.js` and
`node tests/report-sources.test.js`. These checks use generated data and make
no requests to Google Sheets.
