// Prism offscreen — pdf.js text extraction for MV3 service worker
// Runs with DOM, can use pdf.js worker
try { pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js'); } catch {}
const pending = new Map();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'PRISM_PDF_EXTRACT') return false;
  const id = msg.id;
  (async () => {
    try {
      const bytes = new Uint8Array(msg.data);
      const doc = await pdfjsLib.getDocument({ data: bytes, useSystemFonts: true, disableRange: true }).promise;
      let text = '';
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        // join with space, preserve page breaks
        const pageText = content.items.map(it => it.str).join(' ');
        text += pageText + '\n';
        // avoid huge PDFs
        if (text.length > 500000) break;
      }
      sendResponse({ id, ok: true, text: text.trim() });
    } catch (e) {
      sendResponse({ id, ok: false, error: e.message || String(e) });
    }
  })();
  return true;
});
