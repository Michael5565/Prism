// Manual-search mode: user searches in Drive / Docs / Sheets / Slides native searchbar.
// Extension harvests visible file IDs from the open Drive tab, then fetches text via session export endpoints.
// No file picker, no fullText Drive API search — avoids OAuth verification & quotas.

const TIMEOUT_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 30000;

function isValidGoogleId(id = "") {
  if (!id || typeof id !== "string") return false;
  if (id.startsWith("http") || id.includes("/") || id.includes(".") || id.includes(":") || id.includes(" ")) return false;
  return /^[a-zA-Z0-9_-]{18,60}$/.test(id);
}

function isInvalidName(name = "") {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  if (n.startsWith("http://") || n.startsWith("https://")) return true;
  if (/^\d+\s*(gb|mb|kb|b)$/i.test(n)) return true;
  if (n === "storage" || n === "trash" || n === "my drive" || n === "shared with me" || n === "recent" || n === "starred") return true;
  return false;
}

function isSupportedDocMime(mime = "") {
  if (!mime) return true;
  const m = mime.toLowerCase();
  if (m.includes("folder") || m.includes("shortcut") || m.includes("image/") || m.includes("video/") || m.includes("audio/")) return false;
  if (m.includes("document") || m.includes("sheet") || m.includes("presentation") || m.includes("pdf") || m.includes("text") || m.includes("csv") || m.includes("openxmlformats")) return true;
  return false;
}

function isExcludedFile(name = "") {
  const n = (name || "").toLowerCase();
  if (n.includes('whatsapp image') || n.includes('screenshot')) return true;
  return /\.(jpg|jpeg|png|gif|webp|svg|mp4|mov|avi|mkv|mp3|wav|zip|tar|gz|dmg|exe|iso|bin)$/i.test(n);
}

// Fast direct export candidate
async function fetchExport(url) {
  try {
    const res = await fetch(url, {
      credentials: "include",
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (!type.includes("text/plain") && !type.includes("text/csv") && !type.includes("application/octet-stream")) return null;
    const text = await res.text();
    if (text && !text.trimStart().startsWith("<")) return text.trim();
  } catch (_) {}
  return null;
}

function detectKind(bytes) {
  const b = new Uint8Array(bytes);
  if (b[0] === 0x50 && b[1] === 0x4b) return "zip";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf";
  return "text";
}

async function fetchDriveBinary(id) {
  const tryUrls = [
    `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
    `https://drive.google.com/uc?export=download&confirm=t&id=${id}`
  ];
  let lastErr = null;
  for (const u of tryUrls) {
    const shortUrl = u.slice(0, 80);
    try {
      console.log(`[Prism:api] fetchDriveBinary trying ${shortUrl}...`);
      const res = await fetch(u, { credentials: "include", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      const ct = (res.headers.get("content-type")||"").toLowerCase();
      console.log(`[Prism:api] fetchDriveBinary ${shortUrl} status=${res.status} ct=${ct.slice(0,60)}`);
      if (!res.ok) { lastErr = new Error(`download failed (${res.status})`); continue; }
      // Virus-scan interstitial comes back as text/html with an export=download&confirm=TOKEN link
      if (ct.includes("text/html")) {
        const html=await res.text().catch(()=> "");
        console.log(`[Prism:api] fetchDriveBinary got HTML interstitial, length=${html.length}`);
        // Try multiple token extraction patterns
        let token = null;
        const patterns = [
          /export=download[^"']*confirm=([0-9A-Za-z-_]+)/,
          /confirm=([0-9A-Za-z-_]+)[^"']*export=download/,
          /confirm=([0-9A-Za-z-_]{20,})/,
          /\/uc\?.*confirm=([0-9A-Za-z-_]+)/,
          /id=([a-zA-Z0-9_-]{20,})[^"']*confirm=([0-9A-Za-z-_]+)/,
        ];
        for (const p of patterns) {
          const m = html.match(p);
          if (m) { token = m[1]; break; }
        }
        if (token) {
          console.log(`[Prism:api] fetchDriveBinary found token, retrying...`);
          for (const base of tryUrls) {
            const withToken = base + (base.includes("?") ? "&" : "?") + "confirm=" + encodeURIComponent(token);
            try {
              const r2 = await fetch(withToken, { credentials: "include", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
              const ct2 = (r2.headers.get("content-type")||"").toLowerCase();
              console.log(`[Prism:api] fetchDriveBinary token retry status=${r2.status} ct=${ct2.slice(0,60)}`);
              if (r2.ok && !ct2.includes("text/html")) {
                const buf = await r2.arrayBuffer();
                console.log(`[Prism:api] fetchDriveBinary token retry got ${buf.byteLength} bytes`);
                return buf;
              }
            } catch (e2) { console.warn(`[Prism:api] fetchDriveBinary token retry error`, e2.message); }
          }
        } else {
          console.log(`[Prism:api] fetchDriveBinary no token found in HTML. First 500 chars:`, html.slice(0, 500));
        }
        lastErr = new Error("no direct download access (html interstitial)"); continue;
      }
      const buf = await res.arrayBuffer();
      console.log(`[Prism:api] fetchDriveBinary got ${buf.byteLength} bytes`);
      return buf;
    } catch (e) { lastErr = e; console.warn(`[Prism:api] fetchDriveBinary error for ${shortUrl}`, e.message); }
  }
  throw lastErr || new Error("download failed");
}

// Returns { text, mimeType } or throws.
// Handles ALL types: Google Docs/Sheets/Slides (export endpoints), PDF, DOCX, XLSX,
// PPTX (any ppt variant via ppt/ zip sniffing), uploaded CSV/TXT — binary fallback
// is ALWAYS attempted because harvested names carry no extensions.
async function fetchSessionText(id, hintMime = "", hintName = "", skipProbes = false) {
  if (!isValidGoogleId(id) || isExcludedFile(hintName) || isInvalidName(hintName)) {
    throw new Error("Invalid or excluded file");
  }

  const mime = (hintMime || "").toLowerCase();

  // 1. Known native type -> hit its export endpoint directly (fast path)
  if (!skipProbes && (mime.includes("spreadsheet") || mime.includes("sheet") || mime.includes("csv"))) {
    // Try CSV first (native Sheets), then XLSX binary fallback below if CSV is first-sheet-only
    const text = await fetchExport(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv`);
    if (text) return { text, mimeType: "application/vnd.google-apps.spreadsheet" };
  } else if (!skipProbes && (mime.includes("presentation") || mime.includes("slides"))) {
    const text = await fetchExport(`https://docs.google.com/presentation/d/${id}/export?txt`);
    if (text) return { text, mimeType: "application/vnd.google-apps.presentation" };
  } else if (!skipProbes && (mime.includes("document") || mime.includes("word"))) {
    const text = await fetchExport(`https://docs.google.com/document/d/${id}/export?format=txt`);
    if (text) return { text, mimeType: "application/vnd.google-apps.document" };
  }

  // 2. RACE all three probes - first success resolves immediately. The old Promise.all
  // waited on every probe incl. slow HTML error pages (~2-6s wasted per mismatched type).
  // Include XLSX export for Sheets with multiple tabs (CSV only exports first sheet)
  if (!skipProbes) {
  const probe = (url, mimeType) =>
    fetchExport(url).then((t) => t ? { text: t, mimeType } : Promise.reject(new Error("probe-miss")));
  const matched = await Promise.any([
    probe(`https://docs.google.com/document/d/${id}/export?format=txt`, "application/vnd.google-apps.document"),
    probe(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv`, "application/vnd.google-apps.spreadsheet"),
    probe(`https://docs.google.com/presentation/d/${id}/export?txt`, "application/vnd.google-apps.presentation")
  ]).catch(() => null);
  if (matched) return matched;
  // Extra: try Sheets XLSX export for multi-sheet workbooks (e.g. OLBSLicenceReport_West of England) — CSV would miss other sheets
  if (hintName && /licence|report|west|olbs/i.test(hintName) || mime.includes("sheet")) {
    try {
      const xlsxBytes = await fetchDriveBinary(id).catch(()=>null); // will go to binary fallback below anyway, but try XLSX export first
      // XLSX export via docs.google.com/spreadsheets/d/{id}/export?format=xlsx returns zip
      const xlsxUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;
      const res = await fetch(xlsxUrl, { credentials: "include", signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(()=>null);
      if (res && res.ok && (res.headers.get("content-type")||"").includes("spreadsheetml")) {
        const buf = await res.arrayBuffer();
        const txt = await xlsxText(buf).catch(()=>null);
        if (txt && txt.trim().length>20) return { text: txt.trim(), mimeType: "application/vnd.google-apps.spreadsheet" };
      }
    } catch(_) {}
  }
  }

// 3. Binary fallback - ALWAYS attempted for documents, but NEVER for true media
// (images/video/audio/archives would decode to garbage)
if (/\.(jpe?g|png|gif|webp|svg|bmp|ico|tiff?|mp4|mov|avi|mkv|webm|mp3|wav|ogg|m4a|zip|rar|7z|tar|gz|dmg|exe|iso|bin|apk)$/i.test(hintName || '')) {
    throw new Error("media file - no text");
}
console.log(`[Prism:api] binary fallback for ${id.slice(0,8)} hintMime="${hintMime}" hintName="${(hintName||'').slice(0,40)}"`);
const bytes = await fetchDriveBinary(id);
console.log(`[Prism:api] binary downloaded ${id.slice(0,8)} size=${bytes.byteLength}`);

// Reject oversized binaries (>25MB) early
if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("file too large");
let kind = detectKind(bytes);
console.log(`[Prism:api] detected kind=${kind} for ${id.slice(0,8)}`);

if (kind === "zip") {
    try {
      const zip = await openZip(bytes);
      const zipKeys = [...zip.keys()];
      console.log(`[Prism:api] zip entries: ${zipKeys.slice(0,10).join(', ')}`);
      if (zip.has("word/document.xml")) {
        const txt = await docxText(bytes);
        console.log(`[Prism:api] docx extracted ${txt.length} chars`);
        return { text: txt, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
      }
      if (zip.has("xl/workbook.xml")) {
        const txt = await xlsxText(bytes);
        const sheetMap = xlsxText._lastSheetMap || [];
        console.log(`[Prism:api] xlsx extracted ${txt.length} chars sheetMap ${sheetMap.length}`);
        return { text: txt, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sheetMap };
      }
      if (zipKeys.some((k) => k.startsWith("ppt/slides/"))) {
        const txt = await pptxText(bytes);
        console.log(`[Prism:api] pptx extracted ${txt.length} chars`);
        return { text: txt, mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
      }
      console.log(`[Prism:api] zip but no known office format. Keys: ${zipKeys.join(', ')}`);
    } catch (e) {
      console.warn(`[Prism:api] Binary zip parse error for ${id.slice(0,8)}`, e.message);
    }
    throw new Error("Unsupported zip archive");
}
if (kind === "pdf") {
    console.log(`[Prism:api] attempting PDF extraction for ${id.slice(0,8)}`);
    try {
      const extracted = await pdfText(bytes);
      console.log(`[Prism:api] pdfText returned ${extracted?.length||0} chars`);
      if (extracted && extracted.trim()) { return { text: extracted.trim(), mimeType: "application/pdf" }; }
      console.log(`[Prism:api] PDF extraction returned empty text`);
    } catch (e) {
      console.warn(`[Prism:api] PDF text extraction error for ${id.slice(0,8)}`, e.message);
    }
    // PDF extraction failed — fall through to text decode as last resort
    // but ALWAYS return mime as application/pdf so it categorizes correctly
    kind = 'pdf_fallback'; // signal to text decode below to preserve PDF mime
}
  // For text/csv/txt files: decode and validate printable ratio (reject binary garbage e.g. images)
  console.log(`[Prism:api] falling through to text decode for ${id.slice(0,8)}`);
  let text = new TextDecoder().decode(bytes);
  const sample = text.slice(0, 4000);
  let printable = 0;
  for (const ch of sample) { const c = ch.codePointAt(0); if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c > 159) printable++; }
  if (sample.length && printable / sample.length < 0.85) {
    console.log(`[Prism:api] binary content rejected (printable ratio ${(printable/sample.length).toFixed(2)}) for ${id.slice(0,8)}`);
    throw new Error("binary content - not a document");
  }
  if (!text.trim()) throw new Error("empty file");
  // Preserve csv mime only when the hint or content clearly looks like CSV
  const hintLower=(hintName||'').toLowerCase();
  const looksCsv=hintLower.endsWith('.csv') || hintLower.endsWith('.tsv') || (text.split('\n').slice(0,4).filter(l=>l.includes(',')).length>=2);
  const finalMime = kind === 'pdf_fallback' ? 'application/pdf' : looksCsv ? 'text/csv' : 'text/plain';
  console.log(`[Prism:api] text fallback got ${text.trim().length} chars for ${id.slice(0,8)} mime=${finalMime}`);
  return { text: text.trim(), mimeType: finalMime };
}

// Query-driven search via session cookies (no OAuth) — calls Drive's internal endpoints
function buildTypeClause(type) {
  switch (type) {
    case "doc": return "mimeType = 'application/vnd.google-apps.document' or mimeType contains 'wordprocessingml' or mimeType = 'text/plain'";
    case "sheet": return "mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType contains 'spreadsheetml' or mimeType = 'text/csv'";
    case "slide": return "mimeType = 'application/vnd.google-apps.presentation' or mimeType contains 'presentationml'";
    case "pdf": return "mimeType = 'application/pdf'";
    default: return "mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.google-apps.presentation' or mimeType = 'application/pdf' or mimeType = 'text/plain' or mimeType = 'text/csv' or mimeType contains 'openxmlformats'";
  }
}

async function getSapisidHash() {
  // Kept for optional legacy fallback — not used in manual-search mode
  try {
    if (typeof chrome !== "undefined" && chrome.cookies && chrome.cookies.getAll) {
      const getAll = (filter) => new Promise((res) => chrome.cookies.getAll(filter, (c) => res(c || [])));
      let cookies = await getAll({ domain: ".google.com" });
      if (!cookies.length) cookies = await getAll({});
      let sapisid = null;
      for (const c of cookies) {
        if (c.name === "SAPISID" || c.name === "__Secure-3PAPISID") { sapisid = c.value; break; }
      }
      if (!sapisid) return null;
      const ts = Math.floor(Date.now() / 1000);
      const origin = "https://drive.google.com";
      const str = `${ts} ${sapisid} ${origin}`;
      const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
      const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      return `SAPISIDHASH ${ts}_${hex}`;
    }
  } catch (_) {}
  return null;
}

// Harvest visible file links from whatever Google tab the user is looking at.
// Supports drive.google.com, docs.google.com, sheets, slides — user does the search,
// we just fetch the IDs visible in the DOM. This replaces picker / fullText API search.
async function harvestVisibleIdsFromTab(tabId) {
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const ID_RE = /\/(document|spreadsheets|presentation|file)\/d\/([a-zA-Z0-9_-]{20,})/;
      const FOLDER_RE = /\/drive\/folders\/([a-zA-Z0-9_-]{15,})/;
      const out = new Map();
      const MEDIA_RE = /\.(jpe?g|png|gif|webp|svg|bmp|ico|tiff?|mp4|mov|avi|mkv|webm|mp3|wav|ogg|zip|rar|7z|exe|dmg|apk)(\?|$)/i;
      const mimeFromType = (tp, href, loc, nameHint='') => {
        const bareName = (nameHint||'').toLowerCase().split('\n')[0];
        if (MEDIA_RE.test(bareName)) return 'application/vnd.google-apps.media';
        const nameLow = bareName;
        if (nameLow.startsWith('image')) return 'application/vnd.google-apps.media';
        if (nameLow.includes('sheets') || nameLow.includes('spreadsheet')) return 'application/vnd.google-apps.spreadsheet';
        if (nameLow.includes('slides') || nameLow.includes('presentation')) return 'application/vnd.google-apps.presentation';
        if (nameLow.includes('docs') && nameLow.includes('google')) return 'application/vnd.google-apps.document';
        if (tp === 'spreadsheets') return 'application/vnd.google-apps.spreadsheet';
        if (tp === 'presentation') return 'application/vnd.google-apps.presentation';
        if (tp === 'document') return 'application/vnd.google-apps.document';
        if (tp === 'file') {
          // try infer from URL or location: if location is sheets/docs/slides home default accordingly
          const low = (href||loc||'').toLowerCase();
          if (low.includes('spreadsheets') || low.includes('/sheets/')) return 'application/vnd.google-apps.spreadsheet';
          if (low.includes('presentation') || low.includes('/slides/')) return 'application/vnd.google-apps.presentation';
          // many Drive files (pdf) - generic fallback, real mime resolved after fetch via detectKind
          return 'application/vnd.google-apps.document';
        }
        // no type in href (data-id) — infer from current page
        const locLow = (loc||location.href||'').toLowerCase();
        if (locLow.includes('/spreadsheets') || locLow.includes('sheets.google.com')) return 'application/vnd.google-apps.spreadsheet';
        if (locLow.includes('/presentation') || locLow.includes('slides.google.com')) return 'application/vnd.google-apps.presentation';
        if (locLow.includes('/document') || locLow.includes('docs.google.com/document')) return 'application/vnd.google-apps.document';
        return 'application/vnd.google-apps.document';
      };
      const add = (id, name, href, tp, rowEl) => {
        if (!id || out.has(id)) return;
        if (href && FOLDER_RE.test(href) && !ID_RE.test(href)) return;
        const clean = (name || id).trim().split("\n")[0].slice(0, 160).trim() || id;
        // Skip images/videos/archives up-front (they yield no searchable text)
        if (MEDIA_RE.test(clean.toLowerCase())) return;
        // Try row-based mime hint for Drive generic file/d links (sheets appear as file)
        let rowHint = '';
        try {
          const row = rowEl || document.querySelector(`[data-id="${id}"]`) || document.querySelector(`[data-doc-id="${id}"]`);
          if (row) {
            rowHint = (row.getAttribute('data-mime-type')||'') + ' ' + (row.getAttribute('aria-label')||'') + ' ' + (row.outerHTML||'').slice(0,800);
            // also check parent row
            const pr = row.closest('[role="row"], [data-id], .Q5txwe, .WYuW0e');
            if (pr) rowHint += ' ' + (pr.outerHTML||'').slice(0,800);
          }
        } catch {}
        const combinedHint = (name||'') + ' ' + rowHint;
        const mimeType = mimeFromType(tp, href, location.href, combinedHint);
        out.set(id, { id, name: clean, mimeType, modifiedTime: null });
      };
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        const m = href.match(ID_RE) || a.href.match(ID_RE);
        if (!m) return;
        const tp = m[1];
        const id = m[2];
        const label = a.getAttribute('aria-label') || a.title || a.textContent || '';
        add(id, label, href, tp, a.closest('[role="row"]')||a.closest('[data-id]')||a);
      });
      // Docs/Sheets/Slides home also uses data-ids
      document.querySelectorAll('[data-id]').forEach((el) => {
        const id = el.getAttribute('data-id');
        if (id && /^[a-zA-Z0-9_-]{20,}$/.test(id)) {
          // try find nearest link for type
          const a = el.querySelector('a[href]') || el.closest('a[href]');
          const href = a ? (a.getAttribute('href')||a.href||'') : '';
          const m = href.match(ID_RE);
          const tp = m ? m[1] : null;
          add(id, el.getAttribute('aria-label') || el.textContent || id, href, tp, el);
        }
      });
      // Drive grid row ids
      document.querySelectorAll('[data-doc-id]').forEach((el) => {
        const id = el.getAttribute('data-doc-id');
        if (id && /^[a-zA-Z0-9_-]{20,}$/.test(id)) {
          // drive row may have mime hint in aria or class — infer via parent href
          const a = el.querySelector('a[href]') || document.querySelector(`a[href*="${id}"]`);
          const href = a ? (a.getAttribute('href')||a.href||'') : '';
          const m = href.match(ID_RE);
          const tp = m ? m[1] : null;
          add(id, el.getAttribute('aria-label') || '', href, tp, el);
        }
      });
      return [...out.values()];
    }
  });
  return injected?.result || [];
}

async function searchDriveViaSessionUi(query) {
  // DEPRECATED: auto-navigating Drive is no longer primary — user is directed to search manually.
  // Kept as fallback: harvest from current Drive/Docs/Sheets tab if open, otherwise instruct user.
  const tabs = await chrome.tabs.query({ url: ["https://drive.google.com/*", "https://docs.google.com/*", "https://sheets.google.com/*", "https://slides.google.com/*", "https://*.google.com/*"] });
  const relevant = tabs.filter(t => /drive\.google\.com|docs\.google\.com|sheet|slide/i.test(t.url || ''));
  if (!relevant.length) throw new Error("Open drive.google.com (or Docs/Sheets/Slides) and search there first, then click Import");
  const ids = await harvestVisibleIdsFromTab(relevant[0].id);
  return { files: ids.slice(0, 50), nextPageToken: null };
}

async function searchDriveIds(query, typeFilter = "all", pageToken = null) {
  // Deprecated in manual-search mode — always harvest visible results instead of API fullText search.
  // Kept for backward-compat: if called, just harvest visible and return empty nextPageToken.
  console.warn("[DriveSearch] searchDriveIds is deprecated — use harvestVisibleIdsFromTab (manual Drive search) instead. Query:", query);
  try {
    const r = await searchDriveViaSessionUi(query);
    // Filter by type if filter active
    if (typeFilter !== "all") {
      const want = typeFilter;
      r.files = r.files.filter(f => {
        const cat = (f.mimeType||"").toLowerCase();
        if (want==="doc") return cat.includes("document")||cat.includes("word");
        if (want==="sheet") return cat.includes("sheet")||cat.includes("spreadsheet");
        if (want==="slide") return cat.includes("presentation")||cat.includes("slide");
        if (want==="pdf") return cat.includes("pdf");
        return true;
      });
    }
    return r;
  } catch (e) {
    // Return empty but instruct caller — pane will show guidance toast
    return { files: [], nextPageToken: null, error: e.message };
  }
}

const TITLE_ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeTitleEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return TITLE_ENTITY_MAP[ent] ?? m;
  });
}
const TITLE_SUFFIX_RE = /\s*-\s*Google (Docs|Sheets|Slides|Drive)\s*$/i;
function editPageUrl(id, mimeType) {
  switch (mimeType) {
    case "application/vnd.google-apps.spreadsheet":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return `https://docs.google.com/spreadsheets/d/${id}/edit`;
    case "application/vnd.google-apps.presentation":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return `https://docs.google.com/presentation/d/${id}/edit`;
    case "application/pdf":
      return `https://drive.google.com/file/d/${id}/view`;
    default:
      return `https://docs.google.com/document/d/${id}/edit`;
  }
}
async function resolveTitle(id, mimeType) {
  try {
    const res = await fetch(editPageUrl(id, mimeType), { credentials: "include", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const html = await res.text();
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (!m) return null;
    const title = decodeTitleEntities(m[1]).replace(TITLE_SUFFIX_RE, "").trim();
    return title && !/^loading/i.test(title) ? title.slice(0, 160) : null;
  } catch (_) { return null; }
}
