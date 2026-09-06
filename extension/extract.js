// Zero-dependency text extraction for Office files. DOCX/XLSX are ZIP
// archives; we parse the central directory manually and inflate entries with
// DecompressionStream, so no bundled libraries are needed.

const XML_ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeXmlEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITY_MAP[ent] ?? m;
  });
}

async function inflateRawSlice(slice) {
  const buf = slice instanceof ArrayBuffer ? slice : await slice.arrayBuffer?.() ?? slice;
  const blob = buf instanceof ArrayBuffer ? new Blob([buf]) : buf;
  const ds = new DecompressionStream("deflate-raw");
  // Blob.stream() not available in some SW contexts — fallback via Response
  let stream;
  try {
    stream = blob.stream().pipeThrough(ds);
  } catch(e) {
    try {
      stream = new Response(blob).body.pipeThrough(ds);
    } catch(e2) {
      // Last resort: try ArrayBuffer view
      const arr = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
      const ds2 = new DecompressionStream("deflate-raw");
      const writer = ds2.writable.getWriter();
      writer.write(arr).catch(()=>{});
      writer.close().catch(()=>{});
      stream = ds2.readable;
    }
  }
  return await new Response(stream).arrayBuffer();
}

// Returns Map<entryName, () => Promise<ArrayBuffer>> for a zip ArrayBuffer.
async function openZip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;

  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) {
    // Log first bytes for debugging
    const magic = Array.from(bytes.slice(0, 4)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
    throw new Error(`Not a valid zip file (magic: ${magic}, size: ${len})`);
  }

  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const entries = new Map();

  const te = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) break;
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOff = view.getUint32(ptr + 42, true);
    const name = te.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));

    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;

    if (method === 0 || method === 8) {
      entries.set(name, async () => {
        const slice = buffer.slice(dataStart, dataStart + compSize);
        if (method === 0) return slice;
        return inflateRawSlice(slice);
      });
    }

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function entryText(getEntry) {
  const buf = await getEntry();
  return new TextDecoder().decode(buf);
}

async function docxText(buffer) {
  const zip = await openZip(buffer);
  const doc = zip.get("word/document.xml");
  if (!doc) throw new Error("document.xml missing");
  const xml = await entryText(doc);
  console.log(`[Prism:extract] docx XML length: ${xml.length}`);
  return xml
    .replace(/<w:p[ >]/g, "\n<w:p ")
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "")
    .trim();
}

async function xlsxText(buffer) {
  const zip = await openZip(buffer);
  const sharedStrings = [];
  const shared = zip.get("xl/sharedStrings.xml");
  if (shared) {
    const xml = await entryText(shared);
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const cell = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("");
      sharedStrings.push(decodeXmlEntities(cell));
    }
  }
  function getCellValue(cTag, cInner){
    if (/\bt="s"/.test(cTag)) {
      const vm = cInner.match(/<v[^>]*>(-?\d+)<\/v>/);
      if (vm) {
        const idx = parseInt(vm[1],10);
        if (!isNaN(idx) && sharedStrings[idx] !== undefined) return sharedStrings[idx];
      }
      return "";
    }
    if (/\bt="inlineStr"/.test(cTag) || cInner.includes("<is>")) {
      const im = [...cInner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x=>decodeXmlEntities(x[1])).join("");
      return im;
    }
    const vm = cInner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
    if (vm) return decodeXmlEntities(vm[1].trim());
    const tm = cInner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
    if (tm) return decodeXmlEntities(tm[1].trim());
    return "";
  }
  const allRows = [];
  const sheetGidMap = []; // parallel to allRows, stores sheetIndex
  const sheetNames = [...zip.keys()].filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
  // also try to get sheet names from workbook for gid mapping
  let workbookSheets = [];
  try{ const wb = zip.get("xl/workbook.xml"); if(wb){ const wxml = await entryText(wb); for(const m of wxml.matchAll(/<sheet[^>]+name="([^"]+)"/g)) workbookSheets.push(m[1]); } }catch{}
  for (let sIdx=0; sIdx<sheetNames.length; sIdx++) {
    const name = sheetNames[sIdx];
    const xml = await entryText(zip.get(name));
    const rowMatches = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)];
    if(rowMatches.length){
      for(const rm of rowMatches){
        const rowXml = rm[1];
        const cells = [];
        for(const cm of rowXml.matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)){
          const v = getCellValue(cm[0], cm[1]);
          cells.push(v);
        }
        while(cells.length>1 && cells[cells.length-1]==="") cells.pop();
        if(cells.some(c=>c.trim()!=="")) { allRows.push(cells.join("\t")); sheetGidMap.push(sIdx); }
      }
    } else {
      const cells=[];
      for(const cm of xml.matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)){
        const v=getCellValue(cm[0], cm[1]); if(v) cells.push(v);
      }
      if(cells.length) { allRows.push(cells.join("\t")); sheetGidMap.push(sIdx); }
    }
    if(sheetNames.length>1) { allRows.push(""); sheetGidMap.push(sIdx); }
  }
  // store map for background to use
  xlsxText._lastSheetMap = sheetGidMap;
  xlsxText._lastWorkbookSheets = workbookSheets;
  if (!allRows.length) {
    // ultimate fallback: dump all <t>
    const fallback=[];
    for (const [k, get] of zip.entries()) {
      if (!k.endsWith(".xml")) continue;
      try {
        const xml = await entryText(get);
        for (const tm of xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) {
          const t = decodeXmlEntities(tm[1]).trim();
          if (t) fallback.push(t);
        }
      } catch {}
    }
    return fallback.join("\n").trim();
  }
  // Also ensure sharedStrings searchable but not duplicated as separate lines — header already contains them if they are in sheets
  return allRows.join("\n").trim();
}

async function pptxText(buffer) {
  const zip = await openZip(buffer);
  const slideNames = [...zip.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)));
  const slides = [];
  for (const name of slideNames) {
    const xml = await entryText(zip.get(name));
    const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
    const text = runs.join(" ").replace(/\s+/g, " ").trim();
    if (text) slides.push(text);
  }
  return slides.join("\n\n").trim();
}

// Lightweight PDF text extraction — parses raw PDF bytes for text operators.
// No pdf.js dependency. Works in MV3 service workers.
// Handles most PDFs with extractable (non-scanned) text.
async function decompressBytes(rawBytes) {
  // Try zlib-wrapped deflate first, then raw deflate (some PDF producers use raw)
  for (const fmt of ['deflate', 'deflate-raw']) {
    try {
      const ds = new DecompressionStream(fmt);
      const writer = ds.writable.getWriter();
      const wp = writer.write(new Uint8Array(rawBytes)).then(() => writer.close()).catch(()=>{});
      const reader = ds.readable.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      await wp;
      const totalLen = chunks.reduce((a,c)=>a+c.length,0);
      const out = new Uint8Array(totalLen);
      let off=0; for (const c of chunks){ out.set(c,off); off+=c.length; }
      if (out.length>0) return out;
    } catch {}
  }
  return null;
}

async function pdfText(buffer) {
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;
  console.log(`[Prism:extract] pdfText: parsing ${len} bytes directly`);
  const data = new TextDecoder('latin1').decode(bytes);
  const streamRe = /stream[\r\n \t]/g;
  const endStreamRe = /endstream/g;
  const streamStarts = [];
  let sm;
  while ((sm = streamRe.exec(data)) !== null) {
    if (sm.index >= 3 && data.startsWith('end', sm.index - 3)) continue;
    let bodyStart = sm.index + 'stream'.length;
    if (data[bodyStart] === '\r') bodyStart++;
    if (data[bodyStart] === '\n') bodyStart++;
    streamStarts.push(bodyStart);
  }
  const streamEnds = [];
  let em;
  while ((em = endStreamRe.exec(data)) !== null) streamEnds.push(em.index);
  console.log(`[Prism:extract] pdfText: found ${streamStarts.length} streams`);
  let textContent = '';
  let decompressedCount = 0;
  let textOperatorCount = 0;
  for (let i = 0; i < streamStarts.length; i++) {
    const start = streamStarts[i];
    let end = -1;
    for (let j=0;j<streamEnds.length;j++) if (streamEnds[j] > start) { end = streamEnds[j]; break; }
    if (end <= start) continue;
    const headerStart = Math.max(0, start - 5000);
    const header = data.substring(headerStart, start);
    if (/\/Subtype\s*\/Image/.test(header)) continue;
    if (/\/CMapType/.test(header)) continue;
    const rawStream = bytes.slice(start, end);
    const isFlate = header.includes('/FlateDecode');
    let decoded = null;
    if (isFlate) {
      const dec = await decompressBytes(rawStream);
      if (dec) {
        decoded = new TextDecoder('latin1').decode(dec);
        decompressedCount++;
      } else {
        decoded = new TextDecoder('latin1').decode(rawStream);
      }
    } else {
      decoded = new TextDecoder('latin1').decode(rawStream);
    }
    // Keep stream if it contains text operators OR any Tj/TJ tokens (some PDFs omit BT/ET)
    if (decoded && (hasTextOperators(decoded) || /T[jJ]/.test(decoded))) {
      textContent += decoded + '\n';
      textOperatorCount++;
    } else if (decoded && decoded.length>100 && /\(.*\)/.test(decoded)) {
      // Fallback: streams with lots of literal strings but no operators (rare)
      textContent += decoded + '\n';
    }
  }
  console.log(`[Prism:extract] pdfText: decompressed ${decompressedCount} streams, ${textOperatorCount} had text operators, ${textContent.length} chars total`);
  let text = extractPdfOperators(textContent);
  // Fallback: if BT/ET extraction empty but streams had content, try direct string extraction
  if (!text.trim() && textContent.length>0) {
    console.log('[Prism:extract] pdfText: BT/ET extraction empty, trying fallback direct extraction');
    text = extractTextFallback(textContent);
  }
  console.log(`[Prism:extract] pdfText: extracted ${text.length} chars of readable text`);
  if (text.length > 0) {
    const sample = text.slice(0, 300).replace(/\n/g, '↵');
    console.log(`[Prism:extract] pdfText: sample "${sample}"`);
  } else {
    console.log(`[Prism:extract] pdfText: EMPTY — no readable text found`);
    if (textContent.length > 0) {
      const rawSample = textContent.slice(0, 500).replace(/[\x00-\x08\x0e-\x1f]/g, '?');
      console.log(`[Prism:extract] pdfText: raw textContent sample: "${rawSample}"`);
    }
  }
  return text;
}

function hasTextOperators(s) {
  return /\bBT\b/.test(s) && /\bET\b/.test(s) && /T[jJ][^a-zA-Z]/.test(s);
}

// Check if a string looks like real readable text (not binary garbage)
function looksLikeText(s) {
  if (!s || s.length < 2) return false;
  let printable = 0;
  let letters = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) { printable++; }
    else if (c >= 32 && c < 127) { printable++; if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters++; }
    else if (c >= 128 && c < 160) return false; // control chars = garbage
  }
  // Must have mostly printable chars and at least some letters
  return letters >= 2 && printable / s.length > 0.5;
}

function extractPdfOperators(data) {
  const lines = [];
  let inText = false;
  let i = 0;
  const len = data.length;

  while (i < len) {
    if (!inText) {
      const btIdx = data.indexOf('BT', i);
      if (btIdx === -1) break;
      if (btIdx > 0 && /[a-zA-Z0-9]/.test(data[btIdx - 1])) { i = btIdx + 2; continue; }
      inText = true;
      i = btIdx + 2;
      continue;
    }

    const etIdx = data.indexOf('ET', i);
    if (etIdx === -1) { inText = false; break; }

    const block = data.substring(i, etIdx);
    const extracted = extractTextFromBlock(block);
    // Only keep blocks that look like real text
    if (extracted && looksLikeText(extracted)) {
      lines.push(extracted);
    }
    inText = false;
    i = etIdx + 2;
  }

  return lines
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(l => l.length > 2)
    .join('\n');
}

function extractTextFallback(data) {
  const parts = [];
  const tjRe = /\((?:[^\\)]|\\.)*\)\s*(?:Tj|TJ|'|")|<[0-9a-fA-F\s]+>\s*(?:Tj|TJ)|\[([^\]]*)\]\s*TJ/g;
  let m;
  while ((m = tjRe.exec(data)) !== null) {
    const seg = m[0];
    let txt = '';
    if (seg.trim().startsWith('[')) {
      const arr = m[1] || seg.slice(1, seg.indexOf(']'));
      const tokenRe = /\((?:[^\\)]|\\.)*\)|<[0-9a-fA-F]+>/g;
      let tm; const strs=[];
      while ((tm = tokenRe.exec(arr)) !== null) {
        const tok = tm[0];
        if (tok.startsWith('(')) { const d=unescapePdfString(tok.slice(1,-1)); if (looksLikeText(d)) strs.push(d); }
        else { const hx=tok.slice(1,-1).replace(/\s+/g,''); if(hx.length>=4){ const d=decodePdfHex(hx); if(d&&looksLikeText(d)) strs.push(d);} }
      }
      txt = strs.join(' ');
    } else if (seg.trim().startsWith('(')) {
      const close = seg.indexOf(')');
      const inner = seg.slice(1, close);
      txt = unescapePdfString(inner);
    } else if (seg.trim().startsWith('<')) {
      const hx = seg.slice(1, seg.indexOf('>')).replace(/\s+/g,'');
      if (hx.length>=4) txt = decodePdfHex(hx);
    }
    if (txt && looksLikeText(txt)) parts.push(txt);
    if (parts.length>200) break;
  }
  // If still empty, last resort: grab any long parenthesized strings
  if (parts.length===0) {
    const parenRe = /\((?:[^\\)]|\\.){3,}?\)/g;
    while ((m = parenRe.exec(data)) !== null) {
      const d=unescapePdfString(m[0].slice(1,-1));
      if (looksLikeText(d) && d.length>4) parts.push(d);
      if (parts.length>200) break;
    }
  }
  return parts.join('\n');
}

function extractTextFromBlock(block) {
  const parts = [];
  let i = 0;
  const len = block.length;

  while (i < len) {
    while (i < len && /\s/.test(block[i])) i++;
    if (i >= len) break;

    // TJ array: [...] TJ — may contain (strings) and <hex> tokens
    if (block[i] === '[') {
      const arrEnd = block.indexOf(']', i);
      if (arrEnd !== -1) {
        const arr = block.substring(i + 1, arrEnd);
        const strings = [];
        // Match both (literal strings) and <hex strings> inside the array
        const tokenRe = /\((?:[^\\)]|\\.)*\)|<[0-9a-fA-F]*>/g;
        let tm;
        while ((tm = tokenRe.exec(arr)) !== null) {
          const tok = tm[0];
          if (tok.startsWith('(')) {
            const decoded = unescapePdfString(tok.slice(1, -1));
            if (looksLikeText(decoded)) strings.push(decoded);
          } else if (tok.startsWith('<')) {
            const hex = tok.slice(1, -1);
            if (hex.length >= 4) {
              const decoded = decodePdfHex(hex);
              if (decoded && looksLikeText(decoded)) strings.push(decoded);
            }
          }
        }
        if (strings.length) parts.push(strings.join(' '));
        i = arrEnd + 1;
        while (i < len && /\s/.test(block[i])) i++;
        if (i < len && block[i] === 'T') { i += 2; }
        continue;
      }
    }

    // Tj string: (text) Tj
    if (block[i] === '(') {
      const closeIdx = findBalancedClose(block, i);
      if (closeIdx !== -1) {
        const str = block.substring(i + 1, closeIdx);
        const decoded = unescapePdfString(str);
        if (looksLikeText(decoded)) parts.push(decoded);
        i = closeIdx + 1;
        while (i < len && /\s/.test(block[i])) i++;
        if (i < len && block[i] === 'T') { i += 2; }
        else if (i < len && (block[i] === "'" || block[i] === '"')) { i++; }
        continue;
      }
    }

    // Hex string: <hex> Tj
    if (block[i] === '<') {
      const closeIdx = block.indexOf('>', i);
      if (closeIdx !== -1) {
        const hex = block.substring(i + 1, closeIdx);
        if (hex.length >= 4) {
          const decoded = decodePdfHex(hex);
          if (decoded && looksLikeText(decoded)) parts.push(decoded);
        }
        i = closeIdx + 1;
        while (i < len && /\s/.test(block[i])) i++;
        if (i < len && block[i] === 'T') { i += 2; }
        else if (i < len && (block[i] === "'" || block[i] === '"')) { i++; }
        continue;
      }
    }

    i++;
  }

  return parts.join(' ');
}

// Decode hex string, detecting UTF-16 vs single-byte encoding
function decodePdfHex(hex) {
  // Remove whitespace from hex string
  const clean = hex.replace(/\s+/g, '');
  if (clean.length < 2) return '';

  // Check for UTF-16 BOM
  const first2 = clean.substring(0, 4);
  if (first2 === 'FEFF' || first2 === 'FFFE') {
    // UTF-16 BE or LE
    const isBE = first2 === 'FEFF';
    let result = '';
    for (let h = 4; h + 3 < clean.length; h += 4) {
      const code = parseInt(isBE ? clean.substring(h, h + 4) : clean.substring(h + 2, h + 4) + clean.substring(h, h + 2), 16);
      if (code === 0) continue;
      result += String.fromCharCode(code);
    }
    return result;
  }

  // Single-byte: each pair of hex digits = one character
  let result = '';
  for (let h = 0; h + 1 < clean.length; h += 2) {
    const code = parseInt(clean.substring(h, h + 2), 16);
    if (code === 0) continue;
    result += String.fromCharCode(code);
  }
  return result;
}

function findBalancedClose(s, start) {
  let depth = 1;
  let i = start + 1;
  while (i < s.length && depth > 0) {
    if (s[i] === '(' && s[i - 1] !== '\\') depth++;
    else if (s[i] === ')' && s[i - 1] !== '\\') depth--;
    if (depth === 0) return i;
    i++;
  }
  return -1;
}

function unescapePdfString(s) {
  return s.replace(/\\([nrtbf()\\0-9]{1,3})/g, (m, esc) => {
    if (esc === 'n') return '\n';
    if (esc === 'r') return '\r';
    if (esc === 't') return '\t';
    if (esc === 'b') return '\b';
    if (esc === 'f') return '\f';
    if (esc === '(') return '(';
    if (esc === ')') return ')';
    if (esc === '\\') return '\\';
    // Octal
    if (/^\d{1,3}$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    return esc;
  }).replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

async function exportTextFor(token, file) {
  return exportText(token, file.id, file.mimeType);
}

const GOOGLE_MIMES = {
  "application/vnd.google-apps.document": true,
  "application/vnd.google-apps.spreadsheet": true,
  "application/vnd.google-apps.presentation": true
};

async function extractText(token, file) {
  if (GOOGLE_MIMES[file.mimeType]) {
    return (await exportTextFor(token, file)).trim();
  }
  switch (file.mimeType) {
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return docxText(await downloadMedia(token, file.id));
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return xlsxText(await downloadMedia(token, file.id));
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return pptxText(await downloadMedia(token, file.id));
    case "application/pdf":
      return pdfText(await downloadMedia(token, file.id));
    case "text/plain":
    case "text/markdown":
    case "text/csv":
      return await (await apiFetch(token, `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`)).text();
    default:
      throw new Error(`Unsupported type ${file.mimeType}`);
  }
}
