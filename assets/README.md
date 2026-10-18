# Local document scanning assets

Camera Scan V2 adds an adaptive Quality Gate in `scan-quality.js`: source DPI is calculated from the detected physical document, focus is assessed across several regions, and lighting is classified on a small Worker-side probe. A `fail` or `review` result never deletes an image; the UI requires a retake or an explicit keep decision before saving. Central thresholds live in `ScanQuality.QUALITY_THRESHOLDS`.

`DaiAn.html`, `HamGiang.html`, `LongHiep.html`, `LuuNghiepAnh.html`,
`TapSon.html` and `TraCu.html` use these files for on-device OpenCV scanning,
QR decoding, OCR and PDF generation. Deploy the entire `assets/` directory
alongside the HTML pages, `opencv.js` and `jscanify.min.js`. Serve over HTTPS (or localhost)
for camera and Worker support; opening a file directly is not the supported setup.

- QR: jsQR 1.4.0, executed in `cccd-qr-worker.js`.
- PDF: jsPDF 2.5.1.
- OCR: Tesseract.js 5.1.1, Tesseract.js-core 5.1.1 and local English data.
- Scanning: `document-scan-worker.js` uses the repository's OpenCV/jscanify.
  Preview and capture share one lazily created Worker. OpenCV/jscanify load on
  the main page only when this Worker path is unavailable; Tesseract and QR
  recognition also load on demand. A failed Worker job uses a light fallback
  rather than repeating the full job on the UI thread.
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

`scan-quality.js` limits perspective correction and lighting work to the actual
A3/card placement at 400 dpi by default. A3 is the normal GCN format; choosing
the lower-load 300 dpi option affects subsequent captures/imports, not scans
already taken. Small sources are never enlarged. Automatic lowering to 300 dpi
requires independently verified text/stroke evidence; a preview sharpness score
alone never enables it. Insufficient source resolution is flagged for review.
The “Xem rõ chữ” control opens the full processed image rather than a thumbnail.
Camera focus, glare, wrinkles and the smallest text still need checking on actual
certificates; increasing DPI cannot recover missing content.

The Worker processes a large transferred ImageBitmap directly. Perspective work
uses a bounded crop instead of feeding the full camera image into OpenCV.
Lighting estimation uses small probes, skips already evenly lit pages, and
applies a 256-entry lookup table in strips rather than allocating another full
RGBA image and evaluating a power function for every pixel. Saturated stamp
colors remain protected. Temporary canvases, bitmaps and preview URLs are released.

`pdf-export.js` exports asynchronous JPEG at quality 0.96 using Blob/byte data,
downsampling only when the actual placement exceeds the selected DPI. It groups
pages by compressed image bytes, builds each normal PDF part once, then checks
its exact final size and splits further if needed. Each final PDF is
measured as binary data and capped at 10,000,000 bytes, including PDF overhead.
Long documents split in page order rather than lowering the quality of all pages.
Only a page that exceeds the cap on its own retries JPEG quality 0.94 and
0.92, always encoding from the same export canvas. If it still cannot fit, saving
stops with a clear error and keeps the scans for retry. The combined backup uses
images before geometric and lighting correction with the same export compression;
it is not a byte-exact or lossless archive. A3 orientation follows the image;
cards still fit inside 85.6 x 53.98 mm (swapped for portrait) on A4.
Thumbnail previews remain smaller JPEGs and are never used to generate PDFs.
Original camera/upload bytes stay in a Blob and are decoded only when a QR or
backup task needs them, avoiding a permanently retained native original canvas.
Processed A3 pages are also stored as canonical JPEG Blobs after their previews
are ready, releasing the large processed canvas. PDF assembly embeds those exact
JPEG bytes directly when their placed DPI already fits, avoiding another decode
and lossy encode. Cards keep their much smaller canvas for QR/OCR. Full-size
review displays the same processed JPEG used by the PDF.
Previews are separate 1000-pixel JPEGs. Encoder failures retain a usable original
for retry. Bounded JPEG and PDF caches avoid repeated work on unchanged scans.

Camera preview requests 720p at 10 fps when still-photo capture is supported,
and 1080p otherwise. Still-photo settings are capped with A3/card crop margins
instead of always requesting the maximum sensor mode. The camera stops after
each exposure, while processing/saving, after 45 seconds idle, and on backgrounding.
The next capture can restart it. Video-only capture briefly requests a higher
resolution; “Chụp bằng camera hệ thống” provides another full-quality capture
path when the browser's video frame is inadequate. Pending camera-open requests
are cancelled on stop/reset/background so a delayed permission result cannot
leave the camera running. Preview recognition uses 480 pixels, waits for each
request to finish, and pauses while capture or saving is busy.
Readability still depends on source focus, lighting and resolution; device memory
and Google service limits still apply to very large files.

The browser prepares all required PDF groups before making a save request. `code.gs`
also validates every file's decoded size before any upload or sheet mutation.
A single PDF uses the existing file link. Multiple parts of one kind use a fresh
shared Drive folder, whose link goes into the same original/GCN/CCCD link field.
Parts have numbered filenames, and simultaneous saves never reuse a folder.
Deploy the updated Apps Script before saving split documents: the browser checks
its multipart capability and stops if the deployed API is older. A partial Drive
failure is reported explicitly and retains the previous link for the failed group;
the page keeps the row selected so retry updates the same record.

Each save freezes its metadata, filenames, endpoint, request ID and PDF group
keys. The updated server journals completed parts/groups and the assigned row,
so retry resumes missing parts and a lost response does not duplicate uploads
or append another row. `SAVE_STATUS` checks an uncertain save without resending
PDF data. Complete unchanged saves return locally, and metadata-only edits reuse
the saved PDFs. Existing APIs remain compatible; reliable request replay and
part continuation require deployment of the updated `code.gs`. The server keeps
up to 64 request journals for 24 hours. An expired uncertain request asks the
user to select the existing record rather than guessing and creating a duplicate.
Root folder lookup is cached; multipart files inherit sharing after their new
folder is shared, with per-file sharing fallback if folder sharing fails.

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

Validation from the repository root: `node tests/scan-quality.test.js`,
`node tests/scan-runtime.test.js`, `node tests/camera-lifecycle.test.js`,
`node tests/pdf-export.test.js`,
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


## GitHub performance logs

Save timing is dispatched in the background through the deployed Apps Script and is not stored in the browser. Configure these Apps Script properties: `GITHUB_LOG_TOKEN` (fine-grained token restricted to this repository with Contents read/write), `GITHUB_LOG_REPOSITORY` (defaults to `chidoantracu2025-hoa/thugiay`), `GITHUB_LOG_BRANCH` (defaults to `main`) and `GITHUB_LOG_PATH_PREFIX` (defaults to `performance-logs`). Prefer a dedicated existing log branch so log commits do not trigger main-branch deployment workflows. Never put the token in an HTML file or commit it. Logging is best effort and never changes the record-save result.

After configuring the properties, select and run `authorizeGitHubPerformanceLogging` once in the Apps Script editor, approve the external-request permission, then deploy a new Web App version. The function performs a read-only repository check. Without this authorization Google rejects `UrlFetchApp.fetch` with the missing `script.external_request` scope before GitHub is contacted.

## Adaptive PDF size

Budgets apply to a complete PDF group: processed GCN targets 3,000,000 bytes, two-sided CCCD targets 700,000 bytes, and the original backup targets 2,500,000 bytes with a 3,500,000-byte soft split limit. JPEG quality starts at 0.96 and only steps down while needed; floors are 0.85 for GCN, 0.88 for CCCD and 0.82 for the original backup. The 10,000,000-byte hard safety limit and ordered splitting remain unchanged. On `slow-2g`, `2g`, `3g`, or a reported downlink of at most 2 Mbps, fast mode exports at 300 dpi; quality mode preserves the configured 400 dpi choice. A complete save has a 40-second client wait budget. Timeout keeps images and the idempotent save ID so the next **Cập nhật / lưu tiếp** action checks server status before resending. The source capture and quality metadata are not resized or rewritten. GitHub timing entries include `outputDpi` for field comparison.
