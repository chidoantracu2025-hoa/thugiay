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

PDF images are downsampled to at most 200 pixels per printed inch, based on
actual placement dimensions. Low-resolution originals are never enlarged.
A3 orientation follows the image; cards fit inside 85.6 x 53.98 mm (swapped
for portrait) on A4. JPEG quality starts at 0.84. The combined backup tries
0.76 and 0.68 if necessary to stay below 3 MB, then asks for fewer pages
rather than silently reducing resolution further. This backup contains
images before geometric correction, but is resized and JPEG-compressed.

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

Validation: `node tests/land-scan.test.js` from the repository root.
For image detection, serve the repository with `python3 -m http.server 8765`
and open `http://localhost:8765/tests/document-detection.html`. The browser
harness checks generated flat, wrinkled, skewed and rotated sheets, background
rejection, CCCD exclusion, two-page spreads, and Worker/main-thread agreement.
Add `?sample=test.jpg` to check the local sample as well.
Real camera, lighting, card formats and browser Worker behavior still require
validation on the target devices.
