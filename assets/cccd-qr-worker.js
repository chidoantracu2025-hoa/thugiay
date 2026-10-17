/* QR images stay in this worker. No network or document upload. */
importScripts('./vendor/jsQR.js');

function parseCccdQr(text) {
  const fields = String(text || '').trim().split('|');
  // Common CCCD payload: identity|old identity|name|birth|sex|address|issued.
  // Reject URLs and arbitrary embedded twelve-digit strings.
  if (fields.length < 6 || !/^\d{12}$/.test(fields[0].trim())) return '';
  if (!fields[2].trim()) return '';
  return fields[0].trim();
}

self.onmessage = ({ data }) => {
  const { id, width, height, buffer } = data;
  const envelope = { id };
  if (typeof data.sessionId === 'string') envelope.sessionId = data.sessionId;
  try {
    const pixels = new Uint8ClampedArray(buffer);
    let number = '';
    for (const inversionAttempts of ['dontInvert', 'attemptBoth']) {
      const result = jsQR(pixels, width, height, { inversionAttempts });
      if (result) number = parseCccdQr(result.data);
      if (number) break;
    }
    self.postMessage(Object.assign(envelope, { number }));
  } catch (error) {
    self.postMessage(Object.assign(envelope, { number: '' }));
  }
};
