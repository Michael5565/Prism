// Prism — Injected search pane (Drive + Docs + Sheets + Slides + PDF)
// Clean rewrite of DocLens content-search.js — same streaming port pattern,
// but supports all Drive file types. Light/dark theme preserved.

const LICENSE_SERVER = 'https://prism-license-worker.purrapi.workers.dev';
const FREE_SEARCH_LIMIT = 3;
const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7-day unrestricted free trial
const UPGRADE_URL = 'https://getwalksafe.co.uk/prismpricing';

let currentQuery = '';
let discoveredDocs = [];
let crawledDocIds = new Set();
let allSearchResults = [];
let sidePaneEl = null;
let scanTimeout = null;
let loadTimeout = null;
let observer = null;
let lastUrl = '';
let isWaitingForResults = false;
let isScanningDocuments = false;
let emptyResultsTimer = null;
let hiddenScanIframe = null;
let isHiddenGridScanning = false;
// Pane theme follows Docs Dark Mode — there is no separate toggle.
// Dark when dark mode is switched on and the user is entitled (trial or Pro).
let paneFollowsDark = false;

// Premium & Trial state
let isPremium = false;
let licenseKey = '';
let searchCount = 0;
let searchCountedThisQuery = false;
let installTime = 0;

function getTrialInfo() {
  const now = Date.now();
  const start = installTime || now;
  const remaining = TRIAL_DURATION_MS - (now - start);
  const isTrial = remaining > 0;
  const daysLeft = Math.max(1, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
  return { isTrial, daysLeft };
}

function getActiveAccountIndex() {
  try {
    const m = window.location.pathname.match(/\/u\/(\d+)\//);
    return m ? m[1] : '0';
  } catch { return '0'; }
}

const sheetGidCache = new Map();
async function getSheetGid(id){
  if(sheetGidCache.has(id)) return sheetGidCache.get(id);
  try{
    const resp = await chrome.runtime.sendMessage({type:'GET_SHEET_GID', id});
    const gid = resp && resp.gid ? resp.gid : '0';
    sheetGidCache.set(id, gid);
    console.log(`[Prism] getSheetGid ${id.slice(0,8)} -> ${gid} via bg`);
    return gid;
  }catch{ return '0'; }
}

// Load premium state from storage + recurring validation for monthly/annual renewal
let searchEnabled = true;
try {
  chrome.storage.local.get(['prismPremium', 'prismLicenseKey', 'prismSearchCount', 'prismLicenseValidatedAt', 'prismInstallTime', 'prismSearchEnabled'], (r) => {
    isPremium = !!r.prismPremium;
    licenseKey = r.prismLicenseKey || '';
    searchCount = Math.max(searchCount, r.prismSearchCount || 0);
    installTime = r.prismInstallTime || Date.now();
    searchEnabled = r.prismSearchEnabled !== false;
    if (!r.prismInstallTime) {
      chrome.storage.local.set({ prismInstallTime: installTime });
    }
    const lastValidated = r.prismLicenseValidatedAt || 0;
    const needsRevalidate = isPremium && licenseKey && (Date.now() - lastValidated > 12*60*60*1000);
    if (licenseKey && (!isPremium || needsRevalidate)) {
      validateLicenseKey(licenseKey).then(res=>{
        // Offline (unreachable server): keep existing state, retry later.
        if (res.offline) return;
        if(!res.valid && isPremium){ isPremium=false; savePremiumState(); }
      });
    }
  });
  // periodic re-validation every 12h for recurring monthly/annual
  setInterval(()=>{
    if(isPremium && licenseKey){
      validateLicenseKey(licenseKey).then(res=>{
        if (res.offline) return; // keep Pro while unreachable
        if(!res.valid){ isPremium=false; savePremiumState(); if(!canSearch()) showPaywall(); }
        else chrome.storage.local.set({prismLicenseValidatedAt: Date.now()});
      });
    }
  }, 12*60*60*1000);
} catch {}

function savePremiumState() {
  try {
    chrome.storage.local.set({
      prismPremium: isPremium,
      prismLicenseKey: licenseKey,
      prismSearchCount: searchCount,
      prismLicenseValidatedAt: Date.now(),
    });
  } catch {}
}

function canSearch() {
  if (!searchEnabled) return false;
  if (isPremium) return true;
  const { isTrial } = getTrialInfo();
  if (isTrial) return true;
  return searchCount < FREE_SEARCH_LIMIT;
}

function incrementSearchCount() {
  if (isPremium) return;
  searchCount++;
  savePremiumState();
}

let lastLicenseError = '';
async function validateLicenseKey(key) {
  if (LICENSE_SERVER.includes('YOUR_SUBDOMAIN')) {
    return { valid: false, error: 'License server not configured yet — contact support' };
  }
  const clean = (key || '').trim().toUpperCase();
  if (!clean) return { valid: false, error: 'Enter your license key (PRISM-XXXX)' };
  try {
    const res = await fetch(`${LICENSE_SERVER}/api/validate-license`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: clean }),
    });
    const data = await res.json();
    if (data.valid) {
      isPremium = true;
      licenseKey = clean;
      lastLicenseError = '';
      savePremiumState();
      return { valid: true, status: data.status || 'active' };
    }
    lastLicenseError = data.error || 'Invalid license key';
    return { valid: false, error: lastLicenseError, status: data.status };
  } catch (e) {
    return { valid: false, offline: true, error: 'Could not connect to license server — try again' };
  }
}

function computePaneDark(cb) {
  try {
    chrome.storage.local.get(['docsDarkMode', 'prismPremium', 'prismInstallTime'], (r) => {
      if (r.prismPremium !== undefined) isPremium = !!r.prismPremium;
      if (r.prismInstallTime) installTime = r.prismInstallTime;
      const entitledNow = isPremium || (Date.now() - (installTime || Date.now())) < TRIAL_DURATION_MS;
      cb(r.docsDarkMode !== false && entitledNow);
    });
  } catch { cb(false); }
}
function syncPaneTheme() {
  computePaneDark((dark) => {
    if (dark !== paneFollowsDark) { paneFollowsDark = dark; applyThemeClass(); }
  });
}
try { syncPaneTheme(); } catch {}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.docsDarkMode || changes.prismPremium || changes.prismInstallTime)) syncPaneTheme();
  if (area === 'local' && changes.prismSearchEnabled) {
    searchEnabled = changes.prismSearchEnabled.newValue !== false;
  }
});
function shouldUseDarkTheme(){ return paneFollowsDark; }
function applyThemeClass(){ if(sidePaneEl) sidePaneEl.classList.toggle('dark-theme', shouldUseDarkTheme()); }

// ——— ID validation ———
function isValidDriveId(s){
  if(!s) return false;
  if(s.length < 25 || s.length > 50) return false;
  if(!/^[a-zA-Z0-9-_]+$/.test(s)) return false;
  if(/^(AKfyc|jfk|quantumwiz)/i.test(s)) return false;
  return /[0-9]/.test(s) || /[A-Z]/.test(s);
}
const RAW_ID_ATTRIBUTES = new Set(['href','id','data-id','data-resource-key','jsdata','data-target','data-doc-id','data-automation-id']);
function extractIdFromString(str, allowRawFallback=true){
  if(!str) return null;
  const pats = [
    /\/document\/d\/([a-zA-Z0-9-_]{25,50})/,
    /\/spreadsheets\/d\/([a-zA-Z0-9-_]{25,50})/,
    /\/presentation\/d\/([a-zA-Z0-9-_]{25,50})/,
    /\/file\/d\/([a-zA-Z0-9-_]{25,50})/,
    /[?&]id=([a-zA-Z0-9-_]{25,50})/,
    /\/d\/([a-zA-Z0-9-_]{25,50})=/,
  ];
  for(const re of pats){ const m=str.match(re); if(m && isValidDriveId(m[1])) return m[1]; }
  if(!allowRawFallback) return null;
  const raws=str.match(/[a-zA-Z0-9-_]{25,50}/g);
  if(raws) for(const tok of raws) if(isValidDriveId(tok)) return tok;
  return null;
}
function extractKindFromString(str){
  if(!str) return null;
  if(str.includes('/spreadsheets/d/')) return 'spreadsheets';
  if(str.includes('/presentation/d/')) return 'presentation';
  if(str.includes('/document/d/')) return 'document';
  if(str.includes('/file/d/')) return 'file';
  return null;
}
function mimeFromKind(kind, href, titleHint){
  const hint=(titleHint||'').toLowerCase();
  // Drive rows sometimes expose real mime in data attributes / aria
  if(hint.includes('application/pdf') || hint.includes('application/vnd.openxmlformats')) {
    if(hint.includes('pdf')) return 'application/pdf';
    if(hint.includes('spreadsheetml')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if(hint.includes('wordprocessingml')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if(hint.includes('presentationml')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  if(hint.endsWith('.pdf') || hint.includes('.pdf ') || /\bpdf\b/.test(hint)) return 'application/pdf';
  if(hint.endsWith('.docx') || hint.endsWith('.doc')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if(hint.endsWith('.xlsx') || hint.endsWith('.xls') || hint.endsWith('.csv')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if(hint.endsWith('.pptx') || hint.endsWith('.ppt')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if(hint.includes('image')||hint.includes('photo')||hint.includes('whatsapp')||hint.includes('screenshot')) return 'application/vnd.google-apps.media';
  if(hint.includes('sheet')||hint.includes('spreadsheet')) return 'application/vnd.google-apps.spreadsheet';
  if(hint.includes('slide')||hint.includes('presentation')) return 'application/vnd.google-apps.presentation';
  if(hint.includes('pdf')) return 'application/pdf';
  if(kind==='spreadsheets') return 'application/vnd.google-apps.spreadsheet';
  if(kind==='presentation') return 'application/vnd.google-apps.presentation';
  if(kind==='document') return 'application/vnd.google-apps.document';
  if(kind==='file'){
    const low=(href||'').toLowerCase();
    if(low.includes('.pdf')) return 'application/pdf';
    // Uploaded binaries (pdf/docx/xlsx/csv) — leave UNKNOWN so background goes
    // straight to binary sniffing instead of wasting time on doomed exports
    return '';
  }
  const loc=(location.href||'').toLowerCase();
  if(loc.includes('/spreadsheets')||loc.includes('sheets.google.com')) return 'application/vnd.google-apps.spreadsheet';
  if(loc.includes('/presentation')||loc.includes('slides.google.com')) return 'application/vnd.google-apps.presentation';
  if(loc.includes('/document')) return 'application/vnd.google-apps.document';
  // Drive search hosts everything — leave unknown for background to sniff (pdf/xlsx etc.)
  return '';
}
function getMimeCategory(mime, name){
  const m=(mime||'').toLowerCase(), n=(name||'').toLowerCase();
  if(m.includes('spreadsheet')||m.includes('sheet')||m.includes('csv')||m.includes('excel')||n.endsWith('.csv')||n.endsWith('.xlsx')) return 'sheet';
  if(m.includes('presentation')||m.includes('slide')||m.includes('powerpoint')||n.endsWith('.pptx')) return 'slide';
  if(m.includes('pdf')||n.endsWith('.pdf')) return 'pdf';
  if(m.includes('document')||m.includes('word')||m.includes('msword')) return 'doc';
  return 'doc';
}
function getDriveUrl(id, mime, name){
  const cat=getMimeCategory(mime,name);
  if(cat==='sheet') return `https://docs.google.com/spreadsheets/d/${id}/edit`;
  if(cat==='slide') return `https://docs.google.com/presentation/d/${id}/edit`;
  if(cat==='pdf') return `https://drive.google.com/file/d/${id}/view`;
  // Only use the Docs URL when we actually know it's a document; otherwise let Drive pick the right app
  const m=(mime||'').toLowerCase(), n=(name||'').toLowerCase();
  if(m.includes('document')||m.includes('word')||m.includes('msword')||n.endsWith('.docx')||n.endsWith('.doc')) return `https://docs.google.com/document/d/${id}/edit`;
  return `https://drive.google.com/file/d/${id}/view`;
}

// ——— Title helpers (same as original, trimmed) ———
function isDateLikeTitle(t){
  if(!t) return false;
  t=t.trim();
  if(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(,\s*\d{4})?$/i.test(t)) return true;
  if(/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(t)) return true;
  if(/^\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}$/.test(t)) return true;
  if(/^(today|yesterday)$/i.test(t)) return true;
  if(/^(last opened|opened|modified|edited|viewed|created)\b/i.test(t)) return true;
  return false;
}
function isMeaningfulTitle(t){
  const title=cleanTitle(t);
  if(!title) return false;
  if(isDateLikeTitle(title)) return false;
  const n=title.toLowerCase().replace(/[.…!]+$/,'').trim();
  if(n==='google doc'||n==='google docs'||n==='document') return false;
  // Drive UI chrome that leaks from row containers — filter chips, column headers, loading states
  if(/^(owned by me|owned by anyone|not owned by me|shared with me|location|owner|people|access|type|file type|size|modified|last modified|modified by me|modified by anyone|recent|starred|spam|trash|bin|my drive|computers|shared drives|google drive|search|settings|help|new|anywhere)$/.test(n)) return false;
  if(/^(loading|please wait|sign in)/.test(n)) return false;
  if(/^\d+$/.test(title)) return false;
  if(/^[a-z]{1,3}$/i.test(title)) return false;
  if(/^(open|view|download|share|details|more)$/i.test(title)) return false;
  if(/last opened by me/i.test(title)) return false;
  if(/opened by/i.test(title)) return false;
  if(/you opened/i.test(title)) return false;
  if(/shared with me/i.test(title)) return false;
  if(/starred/i.test(title)) return false;
  if(/recently/i.test(title)) return false;
  if(/more actions/i.test(title)) return false;
  if(/popup button/i.test(title)) return false;
  if(/button/i.test(title)) return false;
  if(/menu/i.test(title)) return false;
  if(/tooltip/i.test(title)) return false;
  if(title.length<3) return false;
  if(title.includes('@')) return false;
  return true;
}
const TITLE_JUNK_RE=/^(owned by me|owned by anyone|not owned by me|shared with me|location|owner|people|access|type|file type|size|modified|last modified|loading.*|my drive|recent|starred|spam|trash|you opened|opened|open)$/i;
function scoreTitleCandidate(t){
  const c=cleanTitle(t);
  if(!c) return -Infinity;
  if(isDateLikeTitle(c)) return -Infinity;
  let s=c.length + c.split(/\s+/).filter(Boolean).length*3;
  if(TITLE_JUNK_RE.test(c.trim())) s-=500;
  if(c.includes('_')) s+=2;
  if(c.includes('.')) s+=1;
  if(c.includes('-')) s+=1;
  if(/^\d+$/.test(c)) s-=100;
  if(c.length<5) s-=10;
  return s;
}
function getTitleFromElement(el){
  if(!el) return 'Untitled';
  const cands=[];
  const add=(v)=>{ if(!v) return; const t=cleanTitle(v); if(isMeaningfulTitle(t)) cands.push(t); };
  el.querySelectorAll('a').forEach(a=>{
    const href=a.getAttribute('href')||'';
    if(href.includes('document/d/')||href.includes('file/d/')||href.includes('spreadsheets/d/')||href.includes('presentation/d/')){
      add(a.innerText); add(a.getAttribute('aria-label')); add(a.getAttribute('title')); add(a.getAttribute('data-tooltip'));
    }
  });
  add(el.getAttribute('aria-label')); add(el.getAttribute('title')); add(el.getAttribute('data-tooltip'));
  el.querySelectorAll('[class*="name"],[class*="title"],[role="link"],[role="button"],[data-tooltip],[aria-label]').forEach(n=>{
    add(n.innerText); add(n.getAttribute('aria-label')); add(n.getAttribute('title'));
  });
  if(el.innerText){ el.innerText.split('\n').map(s=>s.trim()).filter(Boolean).forEach(add); }
  if(cands.length){ cands.sort((a,b)=>scoreTitleCandidate(b)-scoreTitleCandidate(a)); return cands[0]; }
  return 'Untitled';
}
function cleanTitle(t){
  if(!t) return '';
  return t.split('\n')[0]
    .replace(/(Google Docs|Google Doc|Google Sheets|Google Slides|Google Drive|Document|File|Sheet|Presentation|PDF|Word|Docx|Doc)$/gi,'')
    .replace(/^[-\s]+|[-\s]+$/g,'')
    .replace(/\.(gdoc|docx|pdf|txt)$/i,'')
    .trim();
}
const MEDIA_RE = /\.(jpe?g|png|gif|webp|svg|bmp|ico|tiff?|mp4|mov|avi|mkv|webm|mp3|wav|ogg|zip|rar|7z|exe|dmg|apk)(\?|$)/i;

// ——— Discovery (supports Docs/Sheets/Slides/PDF) ———
function discoverDocuments(){
  const map=new Map();
  // Pass 1: anchors
  document.body.querySelectorAll('a[href]').forEach(a=>{
    if (a.closest('#docs-deep-search-pane')) return;
    const href=a.getAttribute('href')||'';
    const id=extractIdFromString(href,true);
    if(!id) return;
    const kind=extractKindFromString(href);
    const container=a.closest('tr')||a.closest('[role="row"]')||a.closest('[role="gridcell"]')||a.closest('.g-list-item')||a.closest('.docs-homescreen-list-item')||a.closest('.docs-homescreen-grid-item')||a.closest('[class*="item"]')||a;
    let title='';
    const rawA = (a.innerText||'').trim();
    const candA = rawA ? cleanTitle(rawA) : '';
    if(candA && isMeaningfulTitle(candA)) title=candA;
    else title=getTitleFromElement(container);
    if(!title || title==='Untitled') title=getTitleFromElement(container);
    // Read data-mime-type from row element (Drive exposes real mime here)
    let rowMime='';
    try {
      const row=container;
      if(row){
        rowMime=(row.getAttribute('data-mime-type')||'').trim();
        if(!rowMime){
          // Walk up to find data-mime-type on parent rows
          const parentRow=row.closest('[data-mime-type]');
          if(parentRow) rowMime=(parentRow.getAttribute('data-mime-type')||'').trim();
        }
      }
    } catch{}
    const rawForMime = (rawA + ' ' + rowMime + ' ' + (container?.getAttribute('aria-label')||'') + ' ' + (container?.innerText||'') + ' ' + (a.getAttribute('aria-label')||'')).trim() || title;
    if(title==='Untitled') title='Untitled';
    if(title && !isMeaningfulTitle(title)) title='Untitled';
    if(MEDIA_RE.test((title||'').toLowerCase())) return;
    let mime=mimeFromKind(kind, href, rawForMime);
    // Override with row-level data-mime-type if available (most reliable source)
    if(rowMime && rowMime.includes('/')) mime=rowMime;
    if(mime && mime.includes('media')) return;
    if(!map.has(id)) map.set(id,{id,title,mimeType:mime});
    else {
      const ex=map.get(id);
      if(ex.title==='Untitled' && title!=='Untitled') ex.title=title;
      if(!ex.mimeType && mime) ex.mimeType=mime;
    }
  });
  // Pass 2: data attributes
  document.body.querySelectorAll('*').forEach(el=>{
    if (el.closest('#docs-deep-search-pane')) return;
    if(!el.attributes) return;
    for(const attr of el.attributes){
      const allow=RAW_ID_ATTRIBUTES.has(attr.name.toLowerCase());
      const id=allow?extractIdFromString(attr.value,true):null;
      if(!id || map.has(id)) { if(id) break; else continue; }
      const container=el.closest('tr')||el.closest('[role="row"]')||el.closest('[role="gridcell"]')||el.closest('.g-list-item')||el.closest('.docs-homescreen-list-item')||el.closest('.docs-homescreen-grid-item')||el.closest('[class*="item"]')||el;
      let title2=getTitleFromElement(container);
      if(title2 && !isMeaningfulTitle(title2)) title2='Untitled';
      // Read data-mime-type from row element
      let rowMime2='';
      try {
        if(container){
          rowMime2=(container.getAttribute('data-mime-type')||'').trim();
          if(!rowMime2){
            const pr=container.closest('[data-mime-type]');
            if(pr) rowMime2=(pr.getAttribute('data-mime-type')||'').trim();
          }
        }
      } catch{}
      const raw2=(container?.innerText||'') + ' ' + rowMime2 + ' ' + (el.getAttribute('aria-label')||'') + ' ' + (el.getAttribute('data-tooltip')||'');
      const nearHref=(el.querySelector('a[href]')?.getAttribute('href'))||'';
      const kind=extractKindFromString(nearHref);
      let mime=mimeFromKind(kind, nearHref, (title2||'') + ' ' + raw2);
      if(rowMime2 && rowMime2.includes('/')) mime=rowMime2;
      const existing=map.get(id);
      if(!existing || (existing.title==='Untitled' && title2!=='Untitled')) map.set(id,{id,title: title2||'Untitled',mimeType:mime});
      else if(!existing.mimeType && mime) existing.mimeType=mime;
      break;
    }
  });
  // Pass 3: Docs/Sheets/Slides home GRID items — no anchors, no data-ids.
  // The file ID lives only in the thumbnail's background-image URL
  // (.../u/0/d/<ID>=w416-h312-p-...); title + app live in the metadata.
  try {
    document.querySelectorAll('.docs-homescreen-grid-item').forEach((item) => {
      try {
        if (item.closest('#docs-deep-search-pane')) return;
        let id = null;
        try {
          const thumb = item.querySelector('.docs-homescreen-grid-item-thumbnail');
          const styleStr = ((thumb && thumb.getAttribute('style')) || item.getAttribute('style') || '');
          if (styleStr.includes('/d/')) id = extractIdFromString(styleStr, true);
        } catch (_) {}
        if (!id || map.has(id)) return;
        let title = '';
        try {
          const tEl = item.querySelector('.docs-homescreen-grid-item-title');
          const rawT = ((tEl && (tEl.getAttribute('title') || tEl.getAttribute('aria-label') || tEl.textContent)) || '').trim();
          const cand = rawT ? cleanTitle(rawT) : '';
          title = (cand && isMeaningfulTitle(cand)) ? cand : (rawT || 'Untitled');
        } catch (_) {}
        if (!title) title = 'Untitled';
        if (title !== 'Untitled' && !isMeaningfulTitle(title)) title = 'Untitled';
        if (MEDIA_RE.test((title || '').toLowerCase())) return;
        // App signal: aria "Google Docs/Sheets/Slides" first, icon class second.
        // NOTE: every class contains the "docs-homescreen" prefix, so match
        // '-docs-type' (with dash) — never bare 'docs'.
        let kind = null;
        try {
          const iconEl = item.querySelector('.docs-homescreen-grid-item-icon');
          const iconCls = (((iconEl && iconEl.innerHTML) || '') + ' ' + ((item.querySelector('.docs-homescreen-grid-item-title') || {}).getAttribute?.('aria-label') || '')).toLowerCase();
          if (iconCls.includes('google sheets') || iconCls.includes('sheet')) kind = 'spreadsheets';
          else if (iconCls.includes('google slides') || iconCls.includes('slid')) kind = 'presentation';
          else if (iconCls.includes('-docs-type') || iconCls.includes('google docs')) kind = 'document';
        } catch (_) {}
        const hintForMime = title + ' ' + kind;
        const mime = mimeFromKind(kind, '', hintForMime);
        map.set(id, { id, title, mimeType: mime });
      } catch (_) {}
    });
  } catch (_) {}
  const out=[...map.values()];
  console.log(`[Prism] discovered ${out.length}`, out.slice(0,3));
  return out;
}
function isListViewActive(){ return !!document.querySelector('.docs-homescreen-list-item') && !document.querySelector('.docs-homescreen-grid-item'); }
function discoverDocumentsWithFallback(){
  return new Promise((resolve)=>{
    const docs=discoverDocuments();
    if(docs.length>0){ resolve(docs); return; }
    if(!isListViewActive() || isHiddenGridScanning){ resolve(docs); return; }
    console.log('[Prism] list view, hidden grid scan…');
    isHiddenGridScanning=true;
    scanViaHiddenGridIframe((gridDocs)=>{ isHiddenGridScanning=false; resolve(gridDocs); });
  });
}
function scanViaHiddenGridIframe(cb, timeoutMs=10000){
  cleanupHiddenScanIframe();
  const iframe=document.createElement('iframe');
  iframe.style.cssText='position:fixed;top:-9999px;left:-9999px;width:1200px;height:900px;border:0;';
  iframe.src=window.location.href;
  document.body.appendChild(iframe);
  hiddenScanIframe=iframe;
  let settled=false;
  const finish=(r)=>{ if(settled) return; settled=true; clearTimeout(t); cleanupHiddenScanIframe(); cb(r); };
  const t=setTimeout(()=>{ console.warn('[Prism] hidden scan timeout'); finish([]); }, timeoutMs);
  iframe.addEventListener('load',()=>{
    let attempts=0;
    const iv=setInterval(()=>{
      attempts++;
      let doc; try{ doc=iframe.contentDocument; }catch{ clearInterval(iv); finish([]); return; }
      const has=doc && doc.querySelector('.docs-homescreen-list-item, .docs-homescreen-grid-item');
      if(has){ clearInterval(iv); switchIframeToGridAndScan(doc, finish); }
      else if(attempts>20){ clearInterval(iv); finish([]); }
    },500);
  });
}
function switchIframeToGridAndScan(doc, finish){
  if(doc.querySelector('.docs-homescreen-grid-item')){ finish(scanIframeForGridDocs(doc)); return; }
  const toggle=doc.querySelector('#docs-homescreen-view-mode');
  if(!toggle){ finish([]); return; }
  ['mousedown','mouseup','click'].forEach(tp=> toggle.dispatchEvent(new MouseEvent(tp,{bubbles:true,cancelable:true,view:doc.defaultView})));
  let a=0;
  const iv=setInterval(()=>{
    a++;
    if(doc.querySelector('.docs-homescreen-grid-item')){ clearInterval(iv); finish(scanIframeForGridDocs(doc)); }
    else if(a>20){ clearInterval(iv); finish([]); }
  },300);
}
function scanIframeForGridDocs(doc){
  const map=new Map();
  doc.querySelectorAll('.docs-homescreen-grid-item').forEach(item=>{
    const thumb=item.querySelector('[class*="thumbnail"]');
    const style=thumb?thumb.getAttribute('style')||'':'';
    const id=extractIdFromString(style,false);
    if(!id) return;
    const title=getTitleFromElement(item);
    if(title && title!=='Untitled') map.set(id,{id,title,mimeType:''});
  });
  return [...map.values()];
}
function cleanupHiddenScanIframe(){ if(hiddenScanIframe){ hiddenScanIframe.remove(); hiddenScanIframe=null; } }

// ——— Query detection ———
function getSearchQuery(){
  const url=new URL(window.location.href);
  if(url.pathname.includes('/drive/') && url.searchParams.has('q')){
    const q=url.searchParams.get('q');
    const m=q.match(/"([^"]+)"/);
    if(m) return m[1];
    return q.replace(/(type|owner|visibility|modified|title|name|has):[^\s]+/g,'').trim()||null;
  }
  if((url.pathname.includes('/document/')||url.pathname.includes('/spreadsheets/')||url.pathname.includes('/presentation/')) && url.searchParams.has('q')){
    return url.searchParams.get('q').trim()||null;
  }
  if(url.pathname.includes('/search')||url.searchParams.has('q')||url.hash.includes('search')){
    const inp=document.querySelector('input[aria-label*="Search"], input[placeholder*="Search"]');
    if(inp && inp.value) return inp.value.trim()||null;
  }
  return null;
}

// ——— Observer + URL polling ———
function init(){
  setInterval(checkUrlChange, 800);
  checkUrlChange();
  setupSearchInputWatcher();
  setupMutationObserver();
}
function checkUrlChange(){
  setupSearchInputWatcher();
  const cur=window.location.href;
  if(cur===lastUrl) return;
  console.log(`[Prism] url change ${lastUrl.slice(0,80)} -> ${cur.slice(0,120)}`);
  lastUrl=cur;
  const q=getSearchQuery();
  console.log(`[Prism] url query="${q}" current="${currentQuery}"`);
  if(q && q!==currentQuery){ console.log(`[Prism] new query "${q}"`); currentQuery=q; resetScan(); waitForResultsToLoad(); }
  else if(!q){ console.log('[Prism] no query -> hide pane'); currentQuery=''; hideSidePane(); }
  else { console.log('[Prism] same query, ignore url change'); if(sidePaneEl && !sidePaneEl.classList.contains('active')) expandSidePane(); }
}
// ——— Search-box watcher ———————————————————————————————————
// Drive search navigates (?q= in URL, caught by the poller) but Docs/Sheets/
// Slides home filter the grid/list client-side with NO URL change — the
// poller never fires there. So watch the actual search inputs as a second
// trigger running the same flow (same quota counting downstream).
// Drive pathnames are excluded: the URL poller owns that flow and typing
// triggers there would double-burn quota on partial queries.
function isPrismSearchInput(el) {
  try {
    if (!el || el.tagName !== 'INPUT') return false;
    if (el.closest('#docs-deep-search-pane')) return false;
    if (el.closest('[role="dialog"]')) return false; // Find & Replace etc.
    if (el.type === 'password' || el.type === 'checkbox' || el.type === 'hidden') return false;
    if (el.offsetParent === null) return false; // hidden
    const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '')).toLowerCase();
    if (!label.includes('search')) return false;
    return true;
  } catch (_) { return false; }
}

function handleSearchBoxQuery(raw) {
  try {
    if (window.location.pathname.includes('/drive/')) return; // URL poller owns Drive
  } catch (_) {}
  const q = (raw || '').trim();
  if (!q) {
    if (currentQuery) {
      let urlQ = null;
      try { urlQ = getSearchQuery(); } catch (_) {}
      if (!urlQ) {
        console.log('[Prism] search box cleared -> hide pane');
        currentQuery = '';
        hideSidePane();
      }
    }
    return;
  }
  if (q.length < 2 || q === currentQuery) return;
  // Still typing (prefix growth while a crawl runs): adopt the fuller term
  // silently instead of resetting — one quota burn per intent, not per pause.
  if (currentQuery && q.startsWith(currentQuery) && (isWaitingForResults || isScanningDocuments)) {
    console.log(`[Prism] search box extended "${currentQuery}" -> "${q}" (adopt silently)`);
    currentQuery = q;
    return;
  }
  console.log(`[Prism] search-box query "${q}"`);
  currentQuery = q;
  resetScan();
  waitForResultsToLoad();
}

function bindSearchInput(el) {
  if (!el || el.dataset.prismSearchBound) return;
  el.dataset.prismSearchBound = '1';
  let deb = null;
  el.addEventListener('input', () => {
    const val = el.value;
    if (!val.trim()) { // cleared — react immediately
      try { if (deb) clearTimeout(deb); } catch (_) {}
      handleSearchBoxQuery('');
      return;
    }
    try { if (deb) clearTimeout(deb); } catch (_) {}
    deb = setTimeout(() => handleSearchBoxQuery(val), 900);
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      try { if (deb) clearTimeout(deb); } catch (_) {}
      handleSearchBoxQuery(el.value);
    }
  });
}

function setupSearchInputWatcher() {
  try {
    document.querySelectorAll('input').forEach((el) => {
      if (isPrismSearchInput(el)) bindSearchInput(el);
    });
  } catch (_) {}
}
function setupMutationObserver(){
  if(observer) observer.disconnect();
  observer=new MutationObserver((muts)=>{
    if(!currentQuery) return;
    if (!canSearch() && (isWaitingForResults || isScanningDocuments)) { showPaywall(); return; }
    if(isWaitingForResults){
      discoverDocumentsWithFallback().then(docs=>{
        if(docs.length>0){ isWaitingForResults=false; if(loadTimeout) clearTimeout(loadTimeout); triggerCrawl(docs); }
      });
      return;
    }
    let hasAdds=false;
    for(const m of muts) if(m.addedNodes.length>0){ hasAdds=true; break; }
    if(hasAdds && !isWaitingForResults){
      if(scanTimeout) clearTimeout(scanTimeout);
      scanTimeout=setTimeout(()=>scanForNewDocuments(), 900);
    }
  });
  observer.observe(document.body,{childList:true,subtree:true});
}
function waitForResultsToLoad(){
  isWaitingForResults=true;
  showSidePaneLoading('Waiting for Drive to render results…');
  expandSidePane();
  discoverDocumentsWithFallback().then(docs=>{
    if(docs.length>0){ isWaitingForResults=false; triggerCrawl(docs); return; }
    if(loadTimeout) clearTimeout(loadTimeout);
    loadTimeout=setTimeout(()=>{
      if(isWaitingForResults){
        discoverDocumentsWithFallback().then(final=>{
          if(final.length>0){ isWaitingForResults=false; triggerCrawl(final); }
          else { showSidePaneLoading('Still scanning… scroll or wait for results'); }
        });
      }
    },5000);
  });
}
function resetScan(){
  console.log(`[Prism] resetScan query="${currentQuery}" crawled=${crawledDocIds.size} hits=${allSearchResults.length}`);
  discoveredDocs=[]; crawledDocIds.clear(); allSearchResults=[]; isWaitingForResults=false; isScanningDocuments=false; paneFilter='all';
  searchCountedThisQuery=false;
  if(scanTimeout) clearTimeout(scanTimeout);
  if(loadTimeout) clearTimeout(loadTimeout);
  if(emptyResultsTimer) clearTimeout(emptyResultsTimer);
  emptyResultsTimer=null; cleanupHiddenScanIframe(); isHiddenGridScanning=false;
}
function triggerCrawl(docs){
  if (!canSearch()) {
    showPaywall();
    return;
  }
  scanForDocumentsAndSearch(docs,false);
}
function scanForNewDocuments(){
  if (!canSearch()) { showPaywall(); return; }
  discoverDocuments().then?null:null;
  const docs=discoverDocuments();
  const fresh=docs.filter(d=>!crawledDocIds.has(d.id));
  if(fresh.length>0) scanForDocumentsAndSearch(fresh,true);
}

// ——— Streaming to background ———
async function scanForDocumentsAndSearch(docsToCrawl){
  if (!canSearch()) { showPaywall(); return; }
  if(!currentQuery || docsToCrawl.length===0) return;
  const fresh=docsToCrawl.filter(d=>!crawledDocIds.has(d.id));
  if(fresh.length===0){ console.log('[Prism] no fresh docs, skip'); return; }
  console.log(`[Prism] crawling ${fresh.length}`, fresh.slice(0,2), `total crawled=${crawledDocIds.size+fresh.length}`);
  fresh.forEach(d=>crawledDocIds.add(d.id));
  fresh.forEach(d=>{ if(!discoveredDocs.some(x=>x.id===d.id)) discoveredDocs.push(d); });
  const total=crawledDocIds.size;
  const hadResults = allSearchResults.length>0;
  isScanningDocuments=true;
  if(emptyResultsTimer) clearTimeout(emptyResultsTimer); emptyResultsTimer=null;
  if(!hadResults){
    showSidePaneLoading('Scanning documents for your term…');
  } else {
    // incremental — don't rebuild pane, just update progress
    updateSidePaneStatus(`Scanning ${total} documents…`);
  }
  let port;
  try{ port=chrome.runtime.connect({name:'search-docs-stream'}); }
  catch(e){
    isScanningDocuments=false;
    if(allSearchResults.length===0) renderError('Could not connect to background. Reload the page.');
    return;
  }
  port.onMessage.addListener((msg)=>{
    if (!canSearch()) { try{ port.disconnect(); }catch{} isScanningDocuments=false; showPaywall(); return; }
    console.log(`[Prism] port msg ${msg.type} results=${msg.results?.length||0} processed=${msg.processed}/${msg.total}`);
    if(msg.type==='BATCH_RESULTS'){
      if(emptyResultsTimer) clearTimeout(emptyResultsTimer); emptyResultsTimer=null;
      const prog=(typeof msg.processed==='number'&&typeof msg.total==='number')?{processed:msg.processed,total:msg.total}:null;
      if(msg.results && msg.results.length){
        msg.results.forEach(r=>console.log(`[Prism] HIT received mime="${r.mimeType}" title="${(r.title||'').slice(0,30)}" cat=${docCategory(r)}`));
        console.log(`[Prism] BATCH got ${msg.results.length} hits, totalHits=${allSearchResults.length+msg.results.length} sample`, msg.results.slice(0,1));
        const isFirstHit = allSearchResults.length===0;
        allSearchResults.push(...msg.results);
        if(isFirstHit){
          renderResults(allSearchResults,{stillSearching:true,progress:prog});
        } else {
          // incremental append — avoid full reload
          const list=sidePaneEl?.querySelector('.ds-results-list');
          const summary=sidePaneEl?.querySelector('.ds-results-summary');
          if(list){
            msg.results.forEach(doc=>{
              if(paneFilter!=='all' && docCategory(doc)!==paneFilter) return;
              const html=renderDocCard(doc);
              const tmp=document.createElement('div');
              tmp.innerHTML=html;
              const card=tmp.firstElementChild;
              list.appendChild(card);
              // attach listeners for new card only
              card.querySelectorAll('.ds-snippet-item').forEach(el=>{
                el.addEventListener('click',()=>{
                  const id=el.dataset.docId, txt=el.dataset.exactText; const cat=el.dataset.cat;
                  let url; if(cat==='doc' && txt) url=`https://docs.google.com/document/d/${id}/edit#find-text=${encodeURIComponent(txt)}`;
                  else { const mime=el.dataset.mime||''; url=getDriveUrl(id,mime,''); if(txt && cat!=='sheet') url+=`#find-text=${encodeURIComponent(txt.slice(0,60))}`; }
                  window.open(url,'_blank');
                });
              });
                const btn=card.querySelector('.ds-more-btn');
                if(btn){
                  const label=btn.dataset.moreLabel;
                  const toggle=(e)=>{ if(e.target.closest('.ds-snippet-item')) return; if(e.target.closest('.ds-doc-title')) return; const exp=card.classList.toggle('ds-expanded'); btn.textContent=exp?'Show less':label; };
                  card.addEventListener('click',toggle);
                  btn.addEventListener('click',(e)=>{ e.stopPropagation(); toggle(e); });
                }
              });
              if(sidePaneEl){ attachCardActionListeners(sidePaneEl); enableSheetColumnResize(sidePaneEl); attachCarouselListeners(sidePaneEl); }
            // update summary counts + progress without rebuilding
            if(summary){
              const totalMatches=allSearchResults.reduce((s,d)=>s+d.snippets.length,0);
              summary.innerHTML=`Found <strong>${totalMatches}</strong> passages in <strong>${allSearchResults.length}</strong> files. <span class="ds-still-searching">· scanning ${crawledDocIds.size} files…</span>${prog&&prog.total?`<div class="ds-progress-track"><div class="ds-progress-fill" style="width:${Math.min(100,Math.round(prog.processed/prog.total*100))}%"></div></div>`:''}`;
            }
            updatePaneFilterCounts();
          } else {
            renderResults(allSearchResults,{stillSearching:true,progress:prog});
          }
        }
      } else {
        // empty batch — just update progress bar
        const bar=sidePaneEl?.querySelector('.ds-progress-fill');
        if(bar && prog) bar.style.width=`${Math.min(100,Math.round(prog.processed/prog.total*100))}%`;
        const summary=sidePaneEl?.querySelector('.ds-results-summary');
        // if still no hits, keep loader but update text
        if(!summary && prog){
          const loader=sidePaneEl?.querySelector('.ds-loading-text');
          if(loader) loader.textContent=`Scanning ${prog.processed}/${prog.total} files…`;
        }
      }
      return;
    }
    if(msg.type==='SEARCH_COMPLETE'){
      console.log(`[Prism] SEARCH_COMPLETE totalHits=${allSearchResults.length} counted=${searchCountedThisQuery}`);
      isScanningDocuments=false;
      if(!searchCountedThisQuery){
        searchCountedThisQuery=true;
        incrementSearchCount();
      }
      if(allSearchResults.length===0){
        if(emptyResultsTimer) clearTimeout(emptyResultsTimer);
        emptyResultsTimer=setTimeout(()=>renderResults(allSearchResults,{stillSearching:false}), 800);
      } else {
        // finalize progress bar to 100% and remove scanning note
        const summary=sidePaneEl?.querySelector('.ds-results-summary');
        if(summary){
          const totalMatches=allSearchResults.reduce((s,d)=>s+d.snippets.length,0);
          summary.innerHTML=`Found <strong>${totalMatches}</strong> passages in <strong>${allSearchResults.length}</strong> files.`;
          const track=summary.querySelector('.ds-progress-track');
          if(track) track.remove();
        }
      }
      port.disconnect(); return;
    }
    if(msg.type==='SEARCH_ERROR'){
      console.warn('[Prism] SEARCH_ERROR', msg.error);
      isScanningDocuments=false;
      if(emptyResultsTimer) clearTimeout(emptyResultsTimer); emptyResultsTimer=null;
      if(allSearchResults.length===0) renderError(msg.error||'Search failed');
      port.disconnect(); return;
    }
  });
  port.onDisconnect.addListener(()=>{ if(isScanningDocuments){ isScanningDocuments=false; console.warn('[Prism] port closed early'); } });
  console.log(`[Prism] sending SEARCH_DOCS ${fresh.length} docs query="${currentQuery}"`, fresh.slice(0,2));
  fresh.forEach(d=>console.log(`[Prism] doc ${d.id.slice(0,8)} mime="${d.mimeType}" title="${(d.title||'').slice(0,30)}"`));
  port.postMessage({type:'SEARCH_DOCS', docs: fresh.map(d=>({id:d.id,title:d.title,mimeType:d.mimeType||''})), query: currentQuery});
}

// ——— Injected pane UI ———
let paneFilter = 'all';
const DS_ICONS = {
  all: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
  sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>',
  slide: '<path d="M2 3h20"/><path d="M4 3v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3"/><path d="m12 16 0 5"/><path d="m8 21 4-3 4 3"/>',
  pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h1.5a1.25 1.25 0 0 0 0-2.5H9V17"/>',
};
function dsTypeIcon(cat){
  const d=DS_ICONS[cat]||DS_ICONS.doc;
  return `<svg class="ds-type-icon ds-ti-${cat}" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}
// Drive-colored file type badges
const FILE_BADGE = {
  all: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 10 5-10 5L2 7z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/></svg>',
  doc: '<svg width="16" height="16" viewBox="0 0 24 24"><rect x="4" y="2" width="16" height="20" rx="2" fill="#4285F4"/><path d="M8 9h8M8 13h8M8 17h5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
  sheet: '<svg width="16" height="16" viewBox="0 0 24 24"><rect x="4" y="2" width="16" height="20" rx="2" fill="#34A853"/><rect x="7.5" y="8.5" width="9" height="8" fill="none" stroke="#fff" stroke-width="1.4"/><path d="M7.5 12.5h9M12 8.5v8" stroke="#fff" stroke-width="1.4"/></svg>',
  slide: '<svg width="16" height="16" viewBox="0 0 24 24"><rect x="4" y="2" width="16" height="20" rx="2" fill="#FBBC05"/><rect x="7" y="7.5" width="10" height="7" rx="1" fill="none" stroke="#fff" stroke-width="1.4"/><path d="M12 14.5v3M9 19.5h6" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></svg>',
  pdf: '<svg width="16" height="16" viewBox="0 0 24 24"><rect x="4" y="2" width="16" height="20" rx="2" fill="#EA4335"/><text x="12" y="15.5" font-size="7.5" font-weight="700" fill="#fff" text-anchor="middle" font-family="Arial,sans-serif">PDF</text></svg>',
};
function getOrCreateSidePane(){
  if(sidePaneEl) return sidePaneEl;
  sidePaneEl=document.createElement('div');
  sidePaneEl.id='docs-deep-search-pane';
  sidePaneEl.className='docs-search-pane-container active';
  if(shouldUseDarkTheme()) sidePaneEl.classList.add('dark-theme');
  document.body.appendChild(sidePaneEl);
  return sidePaneEl;
}
function ensureHandleExists(pane){
  if(pane.querySelector('.ds-sidebar-handle')) return;
  const h=document.createElement('div');
  h.className='ds-sidebar-handle';
  h.innerHTML='<span class="ds-sidebar-handle-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></span>';
  h.addEventListener('click',(e)=>{ e.stopPropagation(); pane.classList.contains('active')?collapseSidePane():expandSidePane(); });
  // removed pane background click-to-collapse — only X and handle close (per request)
  pane.appendChild(h);
}
function findDriveMain(){
  // User-specified outer Drive container — push this to make space like screenshots
  return document.querySelector('.g3Fmkb') || document.querySelector('[role="main"]') || document.querySelector('div[data-view-type]') || document.querySelector('c-wiz div[jsname="bKEyad"]') || document.querySelector('.a-S-Bj-J');
}
function applyPush(push){
  const main = findDriveMain();
  if(main){
    main.style.transition='margin-right .35s cubic-bezier(0.22,1,0.36,1)';
    main.style.marginRight = push ? '380px' : '';
  }
  document.documentElement.classList.toggle('prism-pushed', push);
}
function collapseSidePane(){ if(sidePaneEl) sidePaneEl.classList.remove('active'); applyPush(false); }
function expandSidePane(){ if(sidePaneEl) sidePaneEl.classList.add('active'); applyPush(true); }
function hideSidePane(){
  if(scanTimeout) clearTimeout(scanTimeout);
  if(loadTimeout) clearTimeout(loadTimeout);
  if(emptyResultsTimer) clearTimeout(emptyResultsTimer);
  isWaitingForResults=false; isScanningDocuments=false;
  cleanupHiddenScanIframe();
  if(sidePaneEl){ sidePaneEl.remove(); sidePaneEl=null; }
  applyPush(false);
}

const DS_GEM_LOGO = '<svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="21" rx="5.5" style="fill:#000"/><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.9 8.9 0 1 0 20.5 14.2z" style="fill:none;stroke:#fff;stroke-width:1.5;stroke-linecap:round"/></svg>';
const DS_ICON_FILE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
const DS_ICON_LAYERS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>';
const DS_ICON_SEARCH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const DS_ICON_LOCK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
function buildHeaderHTML({icon='',title='Prism',showRefresh=false}={}){
  const { isTrial, daysLeft } = getTrialInfo();
  let premiumBadge = '';
  if (isPremium) {
    premiumBadge = '<span class="ds-premium-badge">PRO</span>';
  } else if (isTrial) {
    premiumBadge = `<span class="ds-free-badge" title="7-day free trial active">Trial • ${daysLeft}d left</span>`;
  } else {
    premiumBadge = `<span class="ds-free-badge" title="Free searches used">${searchCount}/${FREE_SEARCH_LIMIT} free</span>`;
  }
  const upgradeBtn = isPremium
     ? ''
     : `<a href="${UPGRADE_URL}" target="_blank" class="ds-upgrade-btn" id="ds-upgrade-btn">Upgrade</a>`;
  const searchBar = `<div class="ds-pane-search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg><input id="ds-pane-input" readonly placeholder="Search with Drive's search bar above" value="${escapeHtml(currentQuery)}" title="Search from Drive's search bar — results appear here" /></div>`;
  const srcCounts={all:allSearchResults.length,doc:0,sheet:0,slide:0,pdf:0};
  allSearchResults.forEach(d=>{ const c=docCategory(d); if(srcCounts[c]!==undefined) srcCounts[c]++; });
  const srcLabel={all:'all types',doc:'docs',sheet:'spreadsheets',slide:'slides',pdf:'pdfs'}[paneFilter]||'all types';
  const srcItems=[['all','All types'],['doc','Docs'],['sheet','Spreadsheets'],['slide','Slides'],['pdf','PDFs']]
    .map(([k,l])=>`<div class="ds-source-item${paneFilter===k?' active':''}" data-source="${k}"><span class="ds-src-badge">${FILE_BADGE[k]}</span>${l}${srcCounts[k]?`<span class="ds-src-count">${srcCounts[k]}</span>`:''}</div>`).join('');
  const filters = `<div class="ds-filter-row"><div class="ds-filter-select ds-source-filter" id="ds-source-filter" title="Filter by file type"><span class="ds-src-badge">${FILE_BADGE[paneFilter]}</span><span class="ds-source-label">${srcLabel}</span><span class="ds-caret">▾</span><div class="ds-source-menu" id="ds-source-menu">${srcItems}</div></div></div>`;
  const headerMenu = `<div class="ds-header-menu" id="ds-header-menu"><div class="ds-menu-item" id="ds-menu-rescan"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> Rescan files</div><div class="ds-menu-item" id="ds-menu-license"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> License</div></div>`;
  return `<div class="ds-header"><div class="ds-header-title"><span class="ds-logo-icon">${icon||DS_GEM_LOGO}</span><span>${title}</span>${premiumBadge}</div><div class="ds-header-actions">${upgradeBtn}<button class="ds-more-btn-icon" id="ds-header-more-btn" title="More options"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button><button class="ds-close-btn" id="ds-close-btn">&times;</button></div></div>${headerMenu}${searchBar}${filters}`;
}
function attachHeaderListeners({showRefresh=false}={}){
  document.getElementById('ds-close-btn').addEventListener('click',()=>collapseSidePane());
  const moreBtn=document.getElementById('ds-header-more-btn');
  const menu=document.getElementById('ds-header-menu');
  if(moreBtn&&menu){
    moreBtn.addEventListener('click',(e)=>{ e.stopPropagation(); menu.classList.toggle('open'); });
    if(attachHeaderListeners._docClose) document.removeEventListener('click', attachHeaderListeners._docClose);
    attachHeaderListeners._docClose=(e)=>{ if(!menu.contains(e.target)&&!moreBtn.contains(e.target)) menu.classList.remove('open'); };
    document.addEventListener('click', attachHeaderListeners._docClose);
  }
  document.getElementById('ds-menu-rescan')?.addEventListener('click',()=>{ menu?.classList.remove('open'); if(currentQuery){ resetScan(); waitForResultsToLoad(); } });
  document.getElementById('ds-menu-license')?.addEventListener('click',(e)=>{ e.stopPropagation(); menu?.classList.remove('open'); toggleLicensePanel(); });
  // Source type filter dropdown
  const sf=document.getElementById('ds-source-filter');
  const sm=document.getElementById('ds-source-menu');
  if(sf&&sm){
    sf.addEventListener('click',(e)=>{ e.stopPropagation(); sm.classList.toggle('open'); });
    if(attachHeaderListeners._srcClose) document.removeEventListener('click', attachHeaderListeners._srcClose);
    attachHeaderListeners._srcClose=(e)=>{ if(!sm.contains(e.target)&&!sf.contains(e.target)) sm.classList.remove('open'); };
    document.addEventListener('click', attachHeaderListeners._srcClose);
    sm.querySelectorAll('.ds-source-item').forEach(it=>it.addEventListener('click',(e)=>{
      e.stopPropagation(); sm.classList.remove('open');
      if(it.dataset.source!==paneFilter){ paneFilter=it.dataset.source; renderResults(allSearchResults,{stillSearching:isScanningDocuments}); }
    }));
  }
  // Settings button — show license input
  const settingsBtn = document.getElementById('ds-settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleLicensePanel();
    });
  }
}

function toggleLicensePanel() {
  const pane = sidePaneEl;
  if (!pane) return;
  const existing = pane.querySelector('.ds-license-panel');
  if (existing) { existing.remove(); return; }
  const panel = document.createElement('div');
  panel.className = 'ds-license-panel';
  panel.innerHTML = `
    <div class="ds-license-header"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg> License key</div>
    <div class="ds-license-status ${isPremium ? 'active' : ''}">${
      isPremium
        ? 'Pro — activated'
        : getTrialInfo().isTrial
          ? `Pro Trial — ${getTrialInfo().daysLeft} days left (unlimited)`
          : `Free searches used — ${searchCount}/${FREE_SEARCH_LIMIT}`
    }</div>
    ${isPremium ? `<div class="ds-license-key-display">${licenseKey.slice(0,8)}...</div>` : `
    <div class="ds-license-input-row">
      <input type="text" class="ds-license-input" placeholder="PRISM-XXXX-XXXX" spellcheck="false" />
      <button class="ds-license-activate-btn">Activate</button>
    </div>
    <div class="ds-license-error" id="ds-license-error"></div>
    <a href="${UPGRADE_URL}" target="_blank" class="ds-license-get-link">Get a license key →</a>
    `}
  `;
  pane.querySelector('.ds-header').after(panel);
  // Attach activate button listener
  const activateBtn = panel.querySelector('.ds-license-activate-btn');
  const input = panel.querySelector('.ds-license-input');
  if (activateBtn && input) {
    activateBtn.addEventListener('click', async () => {
      const key = input.value.trim();
      if (!key) return;
      activateBtn.textContent = 'Checking...';
      activateBtn.disabled = true;
      const result = await validateLicenseKey(key);
      if (result.valid) {
        panel.remove();
        if (currentQuery) { resetScan(); waitForResultsToLoad(); }
        else renderResults(allSearchResults, { stillSearching: false });
      } else {
        const err = document.getElementById('ds-license-error');
        if (err) err.textContent = result.error || 'Invalid key';
        activateBtn.textContent = 'Activate';
        activateBtn.disabled = false;
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); activateBtn.click(); }
    });
  }
}
function showSidePaneLoading(msg='Loading…'){
  const pane=getOrCreateSidePane();
  const q=currentQuery?`<div class="ds-query-pill">Searching for: <span>${formatQueryForDisplay(currentQuery)}</span></div>`:`<div class="ds-query-pill">Search in Drive / Docs / Sheets / Slides</div>`;
  pane.innerHTML=`${buildHeaderHTML()}<div class="ds-content">${q}<div class="ds-loader-container"><div class="ds-spinner"></div><div class="ds-loading-text">${msg}</div></div></div>`;
  attachHeaderListeners(); ensureHandleExists(pane);
}
function updateSidePaneStatus(t){
  const pane=getOrCreateSidePane();
  const el=pane.querySelector('.ds-loading-text');
  if(el) el.innerText=t;
}
function showPaywall(){
  // don't wipe license input while user is typing (keeps reloading bug)
  if(document.querySelector('.ds-license-panel') && document.activeElement?.classList.contains('ds-license-input')) return;
  if(sidePaneEl?.querySelector('.ds-paywall-state') && sidePaneEl?.querySelector('.ds-license-panel')) return;
  isWaitingForResults=false; isScanningDocuments=false;
  if(scanTimeout) clearTimeout(scanTimeout);
  if(loadTimeout) clearTimeout(loadTimeout);
  if(emptyResultsTimer) clearTimeout(emptyResultsTimer);
  emptyResultsTimer=null;
  const pane=getOrCreateSidePane();
  const hadLicense = pane.querySelector('.ds-license-panel');
  const hadLicenseHTML = hadLicense ? hadLicense.outerHTML : null;
  const { isTrial, daysLeft } = getTrialInfo();
  let paywallTitle = isTrial ? 'Free searches limit reached' : '7-day free trial ended';
  let paywallMsg = `Upgrade to Pro for <b>$6.99/mo</b> or <b>$49/yr</b> (Save 42%) for unlimited searches inside Drive files, deep jump-to-paragraph, and Image-Safe Docs Dark Mode.`;
  if(lastLicenseError){
    if(/expired/i.test(lastLicenseError)){ paywallTitle='Subscription expired'; paywallMsg='Your Pro period ended — renew on Paddle to keep unlimited searches. Same key after renewal.'; }
    else if(/cancelled/i.test(lastLicenseError)){ paywallTitle='Subscription cancelled'; paywallMsg='You keep Pro until the period ends — renew anytime on Paddle to continue.'; }
    else if(/past_due|payment/i.test(lastLicenseError)){ paywallTitle='Payment failed'; paywallMsg='Update your card via your Paddle receipt email — access continues during grace.'; }
    else { paywallTitle='License issue'; paywallMsg=lastLicenseError; }
  }
  pane.innerHTML=`${buildHeaderHTML()}<div class="ds-content"><div class="ds-paywall-state"><div class="ds-paywall-icon">${DS_ICON_LOCK}</div><h3>${paywallTitle}</h3><p>${paywallMsg}</p><div class="ds-paywall-actions"><a href="${UPGRADE_URL}" target="_blank" class="ds-paywall-btn primary">Upgrade to Pro ($49/yr) →</a><button class="ds-paywall-btn secondary" id="ds-enter-key-btn">Enter license key</button></div></div></div>`;
  attachHeaderListeners();
  ensureHandleExists(pane);
  if(hadLicenseHTML){
    const header=pane.querySelector('.ds-header');
    if(header){ header.insertAdjacentHTML('afterend', hadLicenseHTML);
      // re-bind license panel events after restore
      const input=pane.querySelector('.ds-license-input'); const btn=pane.querySelector('.ds-license-activate-btn');
      if(btn && input){
        btn.addEventListener('click', async ()=>{
          const key=input.value.trim(); if(!key) return; btn.textContent='Checking...'; btn.disabled=true;
          const result=await validateLicenseKey(key);
          if(result.valid){ const p=pane.querySelector('.ds-license-panel'); if(p) p.remove(); if(currentQuery){ resetScan(); waitForResultsToLoad(); } else renderResults(allSearchResults,{stillSearching:false}); }
          else{ const err=document.getElementById('ds-license-error'); if(err) err.textContent=result.error||'Invalid key'; btn.textContent='Activate'; btn.disabled=false; }
        });
        input.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); btn.click(); }});
      }
    }
  }
  document.getElementById('ds-enter-key-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLicensePanel();
  });
}
function renderError(msg){
  const pane=getOrCreateSidePane();
  pane.innerHTML=`${buildHeaderHTML({title:'Something went wrong'})}<div class="ds-content"><div class="ds-error-state"><p>${escapeHtml(msg)}</p><button class="ds-retry-btn" id="ds-retry-btn">Retry</button></div></div>`;
  attachHeaderListeners();
  document.getElementById('ds-retry-btn').addEventListener('click',()=>{ resetScan(); waitForResultsToLoad(); });
  ensureHandleExists(pane);
}
function docCategory(doc){
  const ml=(doc.mimeType||'').toLowerCase();
  const tl=(doc.title||'').toLowerCase();
  console.log(`[Prism] docCategory: mime="${doc.mimeType}" title="${(doc.title||'').slice(0,30)}"`);
  // Fast-path: explicitly typed PDF/sheet/slide — never override
  if(ml.includes('pdf')||tl.endsWith('.pdf')) return 'pdf';
  if(ml.includes('spreadsheet')||ml.includes('sheet')||ml.includes('csv')||ml.includes('excel')) return 'sheet';
  if(ml.includes('presentation')||ml.includes('slide')||ml.includes('powerpoint')) return 'slide';
  if(ml.includes('document')||ml.includes('word')||ml.includes('msword')||ml.includes('wordprocessingml')||ml.includes('officedocument')) return 'doc';
  let cat=getMimeCategory(doc.mimeType, doc.title);
  if(cat!=='doc' || !doc.snippets || !doc.snippets.length) return cat;
  // Only for unknown / plain-text types: strong tabular signal -> sheet
  const parts=doc.snippets.slice(0,2).map(s=>s.exactText||s.uiText||'');
  if(!parts.some(Boolean)) return cat;
  const rows=parts.map(p=>{
    const cells=parseCsvCells(p);
    const sc=cells.filter(c=>c.trim()).length;
    const avgWords=cells.reduce((a,c)=>a+c.trim().split(/\s+/).filter(Boolean).length,0)/Math.max(1,cells.length);
    return {cells, n:sc, avgWords};
  });
  const avgCols=rows.reduce((a,r)=>a+r.n,0)/rows.length;
  const allTabular=rows.every(r=>r.n>=4 && r.avgWords<=6);
  const commas=parts.reduce((a,t)=>a+(t.match(/,/g)||[]).length,0);
  if(allTabular && avgCols>=4 && (commas>=6 || rows.some(r=>r.n>=5))) cat='sheet';
  return cat;
}
function renderPaneFilterBar(){
  const counts={all:allSearchResults.length,doc:0,sheet:0,slide:0,pdf:0};
  allSearchResults.forEach(d=>{ const c=docCategory(d); if(counts[c]!==undefined) counts[c]++; });
  const chips=[['all','All'],['doc','Docs'],['sheet','Sheets'],['slide','Slides'],['pdf','PDFs']]
    .filter(([k])=>k==='all'||counts[k]>0||paneFilter===k)
    .map(([k,label])=>`<button class="ds-filter-chip${paneFilter===k?' active':''}" data-filter="${k}">${dsTypeIcon(k)}${label}${counts[k]?`<span class="ds-chip-count" data-count="${k}">${counts[k]}</span>`:''}</button>`)
    .join('');
  return `<div class="ds-filters">${chips}</div>`;
}
function updatePaneFilterCounts(){
  if(!sidePaneEl) return;
  const counts={all:allSearchResults.length,doc:0,sheet:0,slide:0,pdf:0};
  allSearchResults.forEach(d=>{ const c=docCategory(d); if(counts[c]!==undefined) counts[c]++; });
  const existing=sidePaneEl.querySelector('.ds-filters');
  if(!existing) return;
  const prevHTML=existing.innerHTML;
  const newBar=renderPaneFilterBar();
  const tmp=document.createElement('div'); tmp.innerHTML=newBar;
  const newFilters=tmp.firstElementChild;
  if(newFilters&&newFilters.innerHTML!==prevHTML){
    existing.replaceWith(newFilters);
    attachFilterListeners(sidePaneEl);
  } else {
    sidePaneEl.querySelectorAll('.ds-chip-count').forEach(el=>{
      const n=counts[el.dataset.count]||0;
      el.textContent=n;
      el.closest('.ds-filter-chip')?.classList.toggle('ds-empty', n===0);
    });
  }
}
function attachFilterListeners(pane){
  pane.querySelectorAll('.ds-filter-chip').forEach(btn=>{
    btn.addEventListener('click',(e)=>{
      e.stopPropagation();
      if(paneFilter===btn.dataset.filter) return;
      paneFilter=btn.dataset.filter;
      renderResults(allSearchResults,{stillSearching:false});
    });
  });
}
function renderResults(results, {stillSearching=false, progress=null}={}){
  if (!canSearch()) { showPaywall(); return; }
  const pane=getOrCreateSidePane();
  const prev=pane.querySelector('.ds-content');
  const prevScroll=prev?prev.scrollTop:0;
  const expanded=new Set([...pane.querySelectorAll('.ds-doc-card.ds-expanded')].map(el=>el.dataset.docId));
  const totalMatches=results.reduce((s,d)=>s+d.snippets.length,0);
  let html='';
  if(totalMatches===0){
    if(isScanningDocuments){ showSidePaneLoading('Scanning… no matches yet'); return; }
    html=`<div class="ds-empty-state"><div class="ds-empty-icon">${DS_ICON_FILE}</div><h3>No matches inside files</h3><p>Scanned ${crawledDocIds.size} files. No passage matched ${formatQueryForDisplay(currentQuery)}.</p></div>`;
  } else {
    const shown=paneFilter==='all'?results:results.filter(d=>docCategory(d)===paneFilter);
    const shownMatches=shown.reduce((s,d)=>s+d.snippets.length,0);
    const note=stillSearching?` <span class="ds-still-searching">· scanning ${crawledDocIds.size} files…</span>`:'';
    const bar=(stillSearching&&progress&&progress.total>0)?`<div class="ds-progress-track"><div class="ds-progress-fill" style="width:${Math.min(100,Math.round(progress.processed/progress.total*100))}%"></div></div>`:'';
    const listHtml=shown.length
      ?`<div class="ds-results-list">${shown.map(renderDocCard).join('')}</div>`
      :`<div class="ds-empty-state"><div class="ds-empty-icon">${DS_ICON_LAYERS}</div><h3>No ${paneFilter} matches</h3><p>${totalMatches} matches exist in other file types — try another filter.</p></div>`;
    html=`${renderPaneFilterBar()}<div class="ds-results-summary">${paneFilter==='all'?`Found <strong>${totalMatches}</strong> passages in <strong>${results.length}</strong> files.`:`<strong>${shownMatches}</strong> passages in <strong>${shown.length}</strong> ${paneFilter} files`}${note}${bar}</div><div class="ds-search-hint">Searching inside your files for <strong>${formatQueryForDisplay(currentQuery)}</strong> — use Drive's search bar above to change the term.</div>${listHtml}<div class="ds-empty-state ds-filter-empty" hidden><div class="ds-empty-icon">${DS_ICON_SEARCH}</div><h3>No results match your filter</h3><p>Clear the filter field to see all ${results.length} files.</p></div>`;
  }
  pane.innerHTML=`${buildHeaderHTML({showRefresh:true})}<div class="ds-content">${html}</div>`;
  attachHeaderListeners({showRefresh:true});
  attachFilterListeners(pane);
  // pane search field is read-only — it mirrors Drive's search term (full search happens in Drive's bar)
  // rich actions: Open / Copy / menu
  attachCardActionListeners(pane);
  pane.querySelectorAll('.ds-snippet-item').forEach(el=>{
    el.addEventListener('click',()=>{
      const id=el.dataset.docId, txt=el.dataset.exactText;
      const cat=el.dataset.cat;
      let url;
      if(cat==='doc' && txt){
        url=`https://docs.google.com/document/d/${id}/edit#find-text=${encodeURIComponent(txt)}`;
      } else {
        const mime=el.dataset.mime||'';
        url=getDriveUrl(id,mime,'');
        if(txt && cat!=='sheet') url+=`#find-text=${encodeURIComponent(txt.slice(0,60))}`;
      }
      window.open(url,'_blank');
    });
  });
  enableSheetColumnResize(pane);
  attachCarouselListeners(pane);
  if(expanded.size>0){
    pane.querySelectorAll('.ds-doc-card').forEach(c=>{
      if(expanded.has(c.dataset.docId)){
        c.classList.add('ds-expanded');
        const b=c.querySelector('.ds-more-btn'); if(b) b.textContent='Show less';
      }
    });
  }
  const nc=pane.querySelector('.ds-content');
  if(nc && prevScroll>0) nc.scrollTop=prevScroll;
  pane.querySelectorAll('.ds-doc-card').forEach(card=>{
    const btn=card.querySelector('.ds-more-btn'); if(!btn) return;
    const label=btn.dataset.moreLabel;
    const hidden = card.querySelector('.ds-hidden-snippets');
    const toggle=(e)=>{
      if(e.target.closest('.ds-snippet-item')) return;
      if(e.target.closest('.ds-doc-title')) return;
      if(e.target.closest('.ds-btn')) return;
      if(e.target.closest('.ds-doc-menu')) return;
      const exp=card.classList.toggle('ds-expanded');
      if(hidden) hidden.hidden = !exp;
      btn.textContent=exp?'Show less':label;
    };
    card.addEventListener('click',toggle);
    btn.addEventListener('click',(e)=>{ e.stopPropagation(); toggle(e); });
  });
  ensureHandleExists(pane);
}
function renderDocCard(doc){
  const cat=docCategory(doc);
  const actionsHtml = `<div class="ds-actions"><button class="ds-btn primary" data-action="open" data-doc-id="${doc.id}" data-mime="${escapeHtml(doc.mimeType||'')}" data-exact="${escapeHtml(doc.snippets[0]?.exactText||'')}">Open in new tab</button><button class="ds-btn" data-action="copy" data-exact="${escapeHtml(doc.snippets[0]?.exactText||doc.snippets[0]?.uiText||'')}">Copy Snippet</button></div>`;
  const titleRow = `<div class="ds-doc-title-row"><span class="ds-file-badge" title="${cat}">${FILE_BADGE[cat]||FILE_BADGE.doc}</span><a href="${getDriveUrl(doc.id, doc.mimeType, doc.title)}" target="_blank" class="ds-doc-title">${escapeHtml(doc.title)}</a><button class="ds-doc-menu" data-menu="${doc.id}" title="More">⋮</button><div class="ds-doc-menu-dropdown" id="menu-${doc.id}"><div class="ds-menu-item" data-menu-action="export" data-doc-id="${doc.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg> Export snippet to Google Doc</div><div class="ds-menu-item" data-menu-action="context" data-doc-id="${doc.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg> View in context</div><div class="ds-menu-item" data-menu-action="annotate" data-doc-id="${doc.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12-12.5z"/></svg> Annotate</div></div></div>`;
  const thumbUrl = `https://drive.google.com/thumbnail?id=${encodeURIComponent(doc.id)}&sz=w200`;
  const thumbHtml = `<div class="ds-thumb-wrap"><img class="ds-thumb" src="${thumbUrl}" loading="lazy" alt="" data-thumb><span class="ds-thumb-fallback">${FILE_BADGE[cat]||FILE_BADGE.doc}</span></div>`;
  const total=doc.snippets.length;
  const slides=doc.snippets.map(s=>renderSnippet(doc.id,s,cat,doc.mimeType,doc.title)).join('');
  const controls=total>1?`<div class="ds-carousel-controls"><button class="ds-carousel-btn" data-dir="-1" title="Previous match"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button><span class="ds-carousel-count">1 / ${total}</span><button class="ds-carousel-btn" data-dir="1" title="Next match"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></button></div>`:'';
  return `<div class="ds-doc-card" data-doc-id="${doc.id}" data-cat="${cat}"><div class="ds-card-main">${thumbHtml}<div class="ds-card-body">${titleRow}<div class="ds-snippet-viewer"><div class="ds-snippet-carousel"><div class="ds-snippet-track">${slides}</div></div>${controls}</div>${actionsHtml}</div></div></div>`;
}
function parseCsvCells(line){
  const cols=[]; let cur='', inQ=false;
  for(const ch of line){
    if(ch==='"') inQ=!inQ;
    else if(ch===','&&!inQ){ cols.push(cur); cur=''; }
    else cur+=ch;
  }
  cols.push(cur);
  return cols;
}
function attachCardActionListeners(scope){
  scope.querySelectorAll('img.ds-thumb:not([data-init])').forEach(img=>{
    img.dataset.init='1';
    img.addEventListener('error', ()=>{ img.style.display='none'; const fb=img.nextElementSibling; if(fb) fb.style.display='grid'; });
    // hide fallback if image loads
    img.addEventListener('load', ()=>{ const fb=img.nextElementSibling; if(fb && img.naturalWidth>10) fb.style.display='none'; });
  });
  scope.querySelectorAll('.ds-btn[data-action="copy"]:not([data-init])').forEach(btn=>{
    btn.dataset.init='1';
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const txt=btn.dataset.exact || btn.closest('.ds-doc-card')?.querySelector('.ds-snippet-item')?.dataset.exactText || '';
      if(!txt) return;
      navigator.clipboard.writeText(txt).then(()=>{ const o=btn.textContent; btn.textContent='Copied ✓'; btn.classList.add('copied'); setTimeout(()=>{btn.textContent=o; btn.classList.remove('copied')},1500); });
    });
  });
  scope.querySelectorAll('.ds-btn[data-action="open"]:not([data-init])').forEach(btn=>{
    btn.dataset.init='1';
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const id=btn.dataset.docId, mime=btn.dataset.mime||'', txt=btn.dataset.exact||'';
      const card=btn.closest('.ds-doc-card'); const cat=card?.dataset.cat||'';
      let url;
      if(cat==='sheet'){
        url=getDriveUrl(id, mime, '');
      } else {
        url = getDriveUrl(id, mime, '');
        if(txt) url+=`#find-text=${encodeURIComponent(txt.slice(0,60))}`;
      }
      window.open(url,'_blank');
    });
  });
  scope.querySelectorAll('.ds-doc-menu:not([data-init])').forEach(btn=>{
    btn.dataset.init='1';
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const card=btn.closest('.ds-doc-card');
      card.classList.toggle('menu-open');
      document.addEventListener('click', function hdr(e2){
        if(!card.contains(e2.target)) card.classList.remove('menu-open');
        document.removeEventListener('click', hdr);
      });
    });
  });
  scope.querySelectorAll('.ds-menu-item:not([data-init])').forEach(item=>{
    item.dataset.init='1';
    item.addEventListener('click', (e)=>{
      e.stopPropagation();
      const action=item.dataset.menuAction, docId=item.dataset.docId;
      const card=scope.querySelector(`.ds-doc-card[data-doc-id="${docId}"]`);
      const snippet = card?.querySelector('.ds-snippet-item')?.dataset.exactText || '';
      card?.classList.remove('menu-open');
      if(action==='context'){
        const mime=card?.querySelector('.ds-snippet-item')?.dataset.mime||'';
        let url=getDriveUrl(docId, mime, ''); if(snippet) url+=`#find-text=${encodeURIComponent(snippet.slice(0,60))}`;
        window.open(url,'_blank');
      } else if(action==='export'){
        navigator.clipboard.writeText(snippet);
        window.open('https://docs.google.com/document/create','_blank');
        alert('Snippet copied — paste in new Google Doc');
      } else if(action==='annotate'){
        alert('Annotate: highlight in Drive coming soon — copied snippet to clipboard');
        navigator.clipboard.writeText(snippet);
      }
    });
  });
}
function attachCarouselListeners(scope){
  scope.querySelectorAll('.ds-snippet-viewer').forEach(v=>{
    if(v.dataset.init) return;
    const track=v.querySelector('.ds-snippet-track');
    if(!track||track.children.length<2){ v.dataset.init='1'; return; }
    v.dataset.init='1';
    const n=track.children.length;
    let i=0;
    const count=v.querySelector('.ds-carousel-count');
    const btns=[...v.querySelectorAll('.ds-carousel-btn')];
    const update=()=>{
      track.style.transform=`translateX(-${i*100}%)`;
      if(count) count.textContent=`${i+1} / ${n}`;
      btns.forEach(b=>{ const d=+b.dataset.dir; b.disabled = d<0 ? i===0 : i===n-1; });
    };
    btns.forEach(b=>b.addEventListener('click',(e)=>{
      e.stopPropagation();
      i=Math.min(n-1,Math.max(0,i+(+b.dataset.dir)));
      update();
    }));
    update();
  });
}
function enableSheetColumnResize(pane){
  pane.querySelectorAll('.ds-sheet-table').forEach(table=>{
    const rows = table.querySelectorAll('.ds-sheet-row');
    let maxCols=0;
    rows.forEach(r=>{ const cols=r.querySelectorAll('.ds-sheet-cell').length; if(cols>maxCols) maxCols=cols; });
    if(maxCols) table.style.gridTemplateColumns = `repeat(${maxCols}, minmax(0, 1fr))`;
  });
  pane.querySelectorAll('.ds-col-resizer:not([data-init])').forEach(resizer=>{
    resizer.dataset.init='1';
    resizer.addEventListener('mousedown', (e)=>{
      e.preventDefault(); e.stopPropagation();
      const col = parseInt(resizer.dataset.col,10);
      const table = resizer.closest('.ds-sheet-table');
      if(!table) return;
      const cols = table.style.gridTemplateColumns.split(' ');
      // ensure cols array length matches maxCols
      const startX = e.clientX;
      // get current width of that column from computed style or colWidths
      const computed = getComputedStyle(table).gridTemplateColumns.split(' ');
      let curW = parseInt(computed[col]) || 120;
      // if computed is like "70px 70px" etc, parse
      if(isNaN(curW)) curW = 120;
      const onMove = (ev)=>{
        const dx = ev.clientX - startX;
        const w = Math.max(70, Math.min(400, curW + dx));
        const newCols = [...computed];
        newCols[col] = w+'px';
        table.style.gridTemplateColumns = newCols.join(' ');
      };
      const onUp = ()=>{
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // swallow the click that fires on mouseup so it can't bubble to open handlers
        const suppress=(ev)=>{ ev.stopPropagation(); ev.preventDefault(); };
        table.addEventListener('click', suppress, {capture:true, once:true});
        setTimeout(()=>table.removeEventListener('click', suppress, {capture:true}), 400);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}
function renderSnippet(docId, snip, cat, mime, docTitle){
  if(snip.isTitleMatch){
    const src = escapeHtml(docTitle||snip.exactText||'');
    const href=getDriveUrl(docId,mime,docTitle);
    return `<div class="ds-snippet-item ds-title-match" data-doc-id="${docId}" data-exact-text="${escapeHtml(snip.exactText)}" data-cat="${cat}" data-mime="${escapeHtml(mime||'')}" title="Title match — open file"><div class="ds-snippet-pass"><div class="ds-title-badge">Title match</div><div class="ds-snippet-main">${highlightKeyword(src, snip.keyword)}</div></div><div class="ds-snippet-source"><span class="ds-src-badge">${FILE_BADGE[cat]||''}</span><a href="${href}" target="_blank">${src.slice(0,28)}</a><span class="ds-page-chip">Title</span></div></div>`;
  }
  const pageIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
  let page;
  if(cat==='sheet') page=`Row ${snip.rowIndex??'?'}`;
  else if(cat==='slide') page=`Slide ${Math.max(1, Math.floor((snip.matchOffset||0)/1800)+1)}`;
  else page=`Page ${Math.max(1, Math.floor((snip.matchOffset||0)/1800)+1)}`;
  const src = docTitle ? escapeHtml(docTitle.slice(0,28))+(docTitle.length>28?'...':'') : '';
  const sourceLine=(href)=>`<div class="ds-snippet-source"><span class="ds-src-badge">${FILE_BADGE[cat]||''}</span>${href?`<a href="${href}" target="_blank">${src||'Open in Drive'}</a>`:`<span>${src}</span>`}<span class="ds-page-chip">${pageIcon} ${page}</span></div>`;
  if(cat==='sheet'){
    const kw=(snip.keyword||'').toLowerCase();
    const renderRow = (row, isHeader, isMatch)=>{
      if(!row) return '';
      let cells;
      if(row.includes('\t')) cells=row.split('\t');
      else if(row.includes(',')) cells=parseCsvCells(row);
      else cells=[row];
      cells=cells.slice(0,8).map(c=>c.trim()).filter((c,i,arr)=>!(arr.length===1 && arr[0]===""));
      if(!cells.length) return '';
      const cls = isHeader ? ' ds-sheet-header' : isMatch ? ' ds-sheet-match' : '';
      const body=cells.map((c, idx)=>`<span class="ds-sheet-cell${isHeader?' ds-header-cell':''}${!isHeader && c.toLowerCase().includes(kw)?' ds-cell-hit':''}" data-col="${idx}">${isHeader?`<b>${escapeHtml(c)}</b>`:highlightKeyword(c, snip.keyword)}<div class="ds-col-resizer" data-col="${idx}"></div></span>`).join('');
      return `<div class="ds-sheet-row${cls}">${body}</div>`;
    };
    let html='<div class="ds-sheet-table">';
    if(snip.header) html+=renderRow(snip.header, true, false);
    if(snip.before) html+=renderRow(snip.before, false, false);
    html+=renderRow(snip.exactText||snip.uiText||'', false, true);
    if(snip.after) html+=renderRow(snip.after, false, false);
    html+='</div>';
    return `<div class="ds-snippet-item ds-sheet-snippet" data-doc-id="${docId}" data-exact-text="${escapeHtml(snip.exactText)}" data-cat="${cat}" data-mime="${escapeHtml(mime||'')}" data-row="${snip.rowIndex||''}" title="Open at this row">${html}${sourceLine(getDriveUrl(docId,mime,docTitle))}</div>`;
  }
  // Match sentence with one sentence of context before/after (muted)
  const main=(snip.exactText||snip.uiText||'').trim();
  const before=(snip.beforeSentence||'').trim();
  const after=(snip.afterSentence||'').trim();
  let body;
  if(before||after){
    body=`<div class="ds-snippet-pass">${before?`<div class="ds-snippet-ctx">${escapeHtml(before)}</div>`:''}<div class="ds-snippet-main">${highlightKeyword(main, snip.keyword)}</div>${after?`<div class="ds-snippet-ctx">${escapeHtml(after)}</div>`:''}</div>`;
  } else {
    // fallback: split into sentences for bullets
    const raw=main;
    const parts=raw.split(/(?<=[.!?])\s+/).filter(s=>s.trim().length>12).slice(0,3);
    const bullets=parts.length?parts:[raw];
    body=`<ul>${bullets.map(b=>`<li>${highlightKeyword(b.trim(), snip.keyword)}</li>`).join('')}</ul>`;
  }
  return `<div class="ds-snippet-item" data-doc-id="${docId}" data-exact-text="${escapeHtml(snip.exactText)}" data-cat="${cat}" data-mime="${escapeHtml(mime||'')}" title="Open at this passage">${body}${sourceLine(getDriveUrl(docId,mime,docTitle))}</div>`;
}
function escapeHtml(s){ if(!s) return ''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
function formatQueryForDisplay(q){ if(!q) return ''; const t=q.trim(); const quoted=/^"(.+)"$/.test(t)||/^'(.+)'$/.test(t); return quoted?escapeHtml(t):`"${escapeHtml(t)}"`; }
function highlightKeyword(text,kw){
  if(!text||!kw) return escapeHtml(text);
  return escapeHtml(text).replace(new RegExp(`(${escapeRegExp(escapeHtml(kw))})`,'gi'),'<mark class="ds-highlight">$1</mark>');
}
function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

try{ chrome.runtime.onMessage.addListener((msg)=>{ if(msg && msg.type==='PRISM_OPEN_LICENSE'){ getOrCreateSidePane(); expandSidePane(); setTimeout(()=>toggleLicensePanel(), 300); return true; } }); }catch{}

init();
