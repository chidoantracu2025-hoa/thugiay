# Local document scanning assets

`HamGiang.html` uses these files for on-device OpenCV scanning, QR decoding,
OCR and PDF generation. Deploy the entire `assets/` directory alongside the
HTML page, `opencv.js` and `jscanify.min.js`. Serve over HTTPS (or localhost)
for camera and Worker support; opening a file directly is not the supported setup.

- QR: jsQR 1.4.0, executed in `cccd-qr-worker.js`.
- PDF: jsPDF 2.5.1.
- OCR: Tesseract.js 5.1.1, Tesseract.js-core 5.1.1 and local English data.
- Scanning: `document-scan-worker.js` uses the repository's OpenCV/jscanify.
  Browsers without OffscreenCanvas use the main-thread compatibility path.
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
Real camera, lighting, card formats and browser Worker behavior still require
validation on the target devices.
