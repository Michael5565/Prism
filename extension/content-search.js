// Prism — Injected search pane (Drive + Docs + Sheets + Slides + PDF)
// Clean rewrite of DocLens content-search.js — same streaming port pattern,
// but supports all Drive file types. Light/dark theme preserved.

const LICENSE_SERVER = 'https://prism-license-worker.purrapi.workers.dev';
const FREE_SEARCH_LIMIT = 5;
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
// Dark when dark mode is switched on.
let paneFollowsDark = false;

// Premium & Trial state
let isPremium = false;
let licenseKey = '';
let searchCount = 0;
let searchCountedThisQuery = false;

function getTodayDateString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function checkSearchQuota() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['isPro', 'prismPremium', 'lifetimeSearchCount'], async (res) => {
      const isPro = !!(res.isPro || res.prismPremium);
      if (isPro) {
        return resolve({ allowed: true, remaining: Infinity, isPro: true });
      }

      const count = typeof res.lifetimeSearchCount === 'number' ? res.lifetimeSearchCount : 0;

      if (count < FREE_SEARCH_LIMIT) {
        const newCount = count + 1;
        searchCount = newCount;
        await chrome.storage.local.set({ lifetimeSearchCount: newCount });
        return resolve({ allowed: true, remaining: FREE_SEARCH_LIMIT - newCount, isPro: false });
      } else {
        searchCount = count;
        return resolve({ allowed: false, remaining: 0, isPro: false });
      }
    });
  });
}

async function getSearchQuota() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['isPro', 'prismPremium', 'lifetimeSearchCount'], (res) => {
      const isPro = !!(res.isPro || res.prismPremium);
      if (isPro) {
        return resolve({ isPro: true, allowed: true, count: 0, remaining: Infinity, limit: FREE_SEARCH_LIMIT });
      }

      const count = typeof res.lifetimeSearchCount === 'number' ? res.lifetimeSearchCount : 0;
      const remaining = Math.max(0, FREE_SEARCH_LIMIT - count);
      return resolve({
        isPro: false,
        allowed: remaining > 0,
        count,
        remaining,
        limit: FREE_SEARCH_LIMIT
      });
    });
  });
}

let quotaAllowed = true;
async function refreshQuota() {
  const q = await getSearchQuota();
  quotaAllowed = q.allowed;
  if (!q.isPro && typeof q.count === 'number') {
    searchCount = q.count;
  }
  return q;
}
refreshQuota();

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
  chrome.storage.local.get(['prismPremium', 'prismLicenseKey', 'prismSearchCount', 'prismLicenseValidatedAt', 'prismSearchEnabled', 'isPro', 'lifetimeSearchCount'], (r) => {
    isPremium = !!(r.prismPremium || r.isPro);
    licenseKey = r.prismLicenseKey || '';
    const storedCount = typeof r.lifetimeSearchCount === 'number' ? r.lifetimeSearchCount : (r.prismSearchCount || 0);
    searchCount = Math.max(searchCount, storedCount);
    searchEnabled = r.prismSearchEnabled !== false;
    if (!searchEnabled && sidePaneEl) {
      hideSidePane();
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
  if (isPremium) return true;
  return quotaAllowed;
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
      try { chrome.storage.local.set({ isPro: true, prismPremium: true }); } catch (_) {}
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
    chrome.storage.local.get(['docsDarkMode'], (r) => {
      cb(r.docsDarkMode !== false);
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
  if (area === 'local' && changes.docsDarkMode) syncPaneTheme();
  if (area === 'local' && changes.prismSearchEnabled) {
    searchEnabled = changes.prismSearchEnabled.newValue !== false;
    if (!searchEnabled) {
      currentQuery = '';
      hideSidePane();
    } else {
      const q = getSearchQuery();
      if (q) {
        currentQuery = q;
        resetScan();
        waitForResultsToLoad();
      }
    }
  }
});
function shouldUseDarkTheme(){ return paneFollowsDark; }
function updateThemeToggleBtnIcon() {
  const tb = document.getElementById('ds-theme-toggle-btn');
  if (!tb) return;
  const isDark = shouldUseDarkTheme();
  tb.title = isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
  tb.setAttribute('aria-label', tb.title);
  tb.innerHTML = isDark
    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
}
function applyThemeClass(){
  if(sidePaneEl) sidePaneEl.classList.toggle('dark-theme', shouldUseDarkTheme());
  updateThemeToggleBtnIcon();
}

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
  // Only use the Docs URL when we actually know it's a native document; otherwise let Drive pick the right app
  const m=(mime||'').toLowerCase(), n=(name||'').toLowerCase();
  if(m==='application/vnd.google-apps.document' || (!mime && !n.includes('.'))) return `https://docs.google.com/document/d/${id}/edit`;
  return `https://drive.google.com/file/d/${id}/view`;
}

function getSnippetPageNumber(snip) {
  if (!snip) return 1;
  const p = parseInt(snip.pageNumber, 10);
  if (p && p > 1) return p;
  const off = parseInt(snip.matchOffset || snip.offset || 0, 10);
  if (off > 0) return Math.max(1, Math.floor(off / 1800) + 1);
  return (p && p > 0) ? p : 1;
}

function openSheetMatch(id, mime, row, term){
  try {
    chrome.runtime.sendMessage({
      type: 'OPEN_SHEET_ROW',
      fileId: id,
      row: row,
      keyword: term
    }, (res)=>{
      if(chrome.runtime.lastError || !res?.ok){
        let url = getDriveUrl(id, mime, '');
        if(row) url += `#gid=0&range=A${row}`;
        if(term) url += `&find-text=${encodeURIComponent(term.slice(0,60))}`;
        window.open(url, '_blank');
      }
    });
  } catch(e) {
    let url = getDriveUrl(id, mime, '');
    if(row) url += `#gid=0&range=A${row}`;
    if(term) url += `&find-text=${encodeURIComponent(term.slice(0,60))}`;
    window.open(url, '_blank');
  }
}

function openPdfMatch(id, mime, txt, kw, offset, page){
  const cleanTxt = (txt || '')
    .replace(/^[…\.][…\.\s]*/, '')
    .replace(/[…\.][…\.\s]*$/, '')
    .replace(/^["'“‘]+/, '')
    .replace(/["'”’]+$/, '')
    .trim();

  const effectiveKw = (kw || currentQuery || '').trim();

  const pInt = parseInt(page, 10);
  const oInt = parseInt(offset, 10);
  const pageNum = (pInt && pInt > 1) ? pInt : ((oInt && oInt > 0) ? Math.max(1, Math.floor(oInt / 1800) + 1) : (pInt || 1));

  const clipText = effectiveKw || cleanTxt;
  if(clipText){
    try {
      navigator.clipboard.writeText(clipText).catch(()=>{});
    } catch(_){}
  }

  // Store jump intent in storage so it survives across all frames and Google Drive URL hash rewrites
  try {
    chrome.storage.local.set({
      prismPendingPdfJump: {
        fileId: id,
        targetText: cleanTxt,
        keyword: effectiveKw,
        pageNum: pageNum,
        timestamp: Date.now()
      }
    });
  } catch (_) {}

  let url = `https://drive.google.com/file/d/${id}/view`;
  const hashParts = [];
  if(pageNum) hashParts.push(`page=${pageNum}`);
  const hashFind = cleanTxt.length > 60 ? cleanTxt.slice(0, 60) : cleanTxt;
  if(hashFind) hashParts.push(`find-text=${encodeURIComponent(hashFind)}`);
  if(effectiveKw) hashParts.push(`kw=${encodeURIComponent(effectiveKw)}`);
  const hashStr = hashParts.join('&');
  if(hashStr) url += '#' + hashStr;
  window.open(url, '_blank');
}

function handleSnippetClick(el) {
  if (!el) return;
  const id = el.dataset.docId;
  const txt = el.dataset.exactText || '';
  const cat = el.dataset.cat || 'doc';
  const row = el.dataset.row || '';
  const kw = el.dataset.keyword || currentQuery || '';
  const mime = el.dataset.mime || '';
  const offset = parseInt(el.dataset.offset || '0', 10);
  const page = parseInt(el.dataset.page || '1', 10);
  const targetPage = page > 1 ? page : (offset > 0 ? Math.max(1, Math.floor(offset / 1800) + 1) : 1);

  const driveUrl = getDriveUrl(id, mime, '');
  const isDrivePreview = driveUrl.includes('drive.google.com/file/d/');

  if (cat === 'sheet') {
    openSheetMatch(id, mime, row, kw || txt);
  } else if (cat === 'slide') {
    let url = `https://docs.google.com/presentation/d/${id}/edit#slide=id.p${targetPage}`;
    if (txt) url += `&find-text=${encodeURIComponent(txt.slice(0, 60))}`;
    window.open(url, '_blank');
  } else if (cat === 'doc' && !isDrivePreview) {
    let url = `https://docs.google.com/document/d/${id}/edit#find-text=${encodeURIComponent(txt)}`;
    if (kw) url += `&kw=${encodeURIComponent(kw)}`;
    window.open(url, '_blank');
  } else {
    openPdfMatch(id, mime, txt, kw, offset, targetPage);
  }
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
  const activeFolder=detectDriveFolder();
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
    if(!map.has(id)) map.set(id,{id,title,mimeType:mime,folderId:activeFolder});
    else {
      const ex=map.get(id);
      if(ex.title==='Untitled' && title!=='Untitled') ex.title=title;
      if(!ex.mimeType && mime) ex.mimeType=mime;
      if(!ex.folderId && activeFolder) ex.folderId=activeFolder;
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
      if(!existing || (existing.title==='Untitled' && title2!=='Untitled')) map.set(id,{id,title: title2||'Untitled',mimeType:mime,folderId:activeFolder});
      else {
        if(!existing.mimeType && mime) existing.mimeType=mime;
        if(!existing.folderId && activeFolder) existing.folderId=activeFolder;
      }
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
        map.set(id, { id, title, mimeType: mime, folderId: activeFolder });
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
    const pm = q.match(/parent:([a-zA-Z0-9-_]{15,70})/i);
    if (pm && pm[1]) {
      lastKnownFolderId = pm[1];
    }
    const m=q.match(/"([^"]+)"/);
    if(m) return m[1];
    return q.replace(/(type|owner|visibility|modified|title|name|has|parent|from|to|before|after|is):[^\s]+/gi,'').trim()||null;
  }
  if((url.pathname.includes('/document/')||url.pathname.includes('/spreadsheets/')||url.pathname.includes('/presentation/')) && url.searchParams.has('q')){
    return url.searchParams.get('q').trim()||null;
  }
  if(url.pathname.includes('/search')||url.searchParams.has('q')||url.hash.includes('search')){
    const inp=document.querySelector('input[aria-label*="Search"], input[placeholder*="Search"]');
    if(inp && inp.value) {
      let val = inp.value.trim();
      const pm = val.match(/parent:([a-zA-Z0-9-_]{15,70})/i);
      if (pm && pm[1]) {
        lastKnownFolderId = pm[1];
      }
      val = val.replace(/(type|owner|visibility|modified|title|name|has|parent|from|to|before|after|is):[^\s]+/gi,'').trim();
      return val || null;
    }
  }
  return null;
}

// ——— Observer + URL polling ———
function init(){
  chrome.storage.local.get(['prismSearchEnabled'], (r) => {
    searchEnabled = r.prismSearchEnabled !== false;
    if (!searchEnabled) {
      hideSidePane();
    } else {
      checkUrlChange();
    }
  });
  setInterval(checkUrlChange, 800);
  setupSearchInputWatcher();
  setupMutationObserver();
}
function checkUrlChange(){
  if (!searchEnabled) {
    if (sidePaneEl) hideSidePane();
    return;
  }
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
  if (!searchEnabled) {
    if (sidePaneEl) hideSidePane();
    return;
  }
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
    if(!searchEnabled || !currentQuery) return;
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
async function waitForResultsToLoad(){
  if (!searchEnabled) {
    hideSidePane();
    return;
  }
  isWaitingForResults=true;
  const quota = await getSearchQuota();
  if(!quota.isPro && !quota.allowed){
    isWaitingForResults=false;
    quotaAllowed = false;
    showPaywall(`You have used your ${FREE_SEARCH_LIMIT} free deep Drive searches. Upgrade to Pro for unlimited search.`);
    return;
  }
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
async function triggerCrawl(docs){
  if (!searchEnabled) return;
  if (!isPremium && !searchCountedThisQuery) {
    const quota = await checkSearchQuota();
    if (!quota.allowed) {
      quotaAllowed = false;
      showPaywall(`You have used your ${FREE_SEARCH_LIMIT} free deep Drive searches. Upgrade to Pro for unlimited search.`);
      return;
    }
    searchCountedThisQuery = true;
    quotaAllowed = true;
  }
  scanForDocumentsAndSearch(docs, false);
}
function scanForNewDocuments(){
  if (!searchEnabled) return;
  if (!canSearch()) { showPaywall(); return; }
  discoverDocuments().then?null:null;
  const docs=discoverDocuments();
  const fresh=docs.filter(d=>!crawledDocIds.has(d.id));
  if(fresh.length>0) scanForDocumentsAndSearch(fresh,true);
}

// ——— Streaming to background ———
async function scanForDocumentsAndSearch(docsToCrawl){
  if (!searchEnabled) { hideSidePane(); return; }
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
        const curFolder = detectDriveFolder();
        const onFolderPage = curFolder && (window.location.pathname.includes('/folders/' + curFolder) || window.location.hash.includes('folders/' + curFolder));
        msg.results.forEach(r => {
          const disc = discoveredDocs.find(d => d.id === r.id);
          if (disc && disc.folderId) {
            r.folderId = disc.folderId;
          } else if (onFolderPage) {
            r.folderId = curFolder;
          }
        });
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
              if(folderScopeActive && curFolder && !isDocInCurrentFolder(doc, curFolder)) return;
              if(paneFilter!=='all' && docCategory(doc)!==paneFilter) return;
              const html=renderDocCard(doc);
              const tmp=document.createElement('div');
              tmp.innerHTML=html;
              const card=tmp.firstElementChild;
              list.appendChild(card);
              // attach listeners for new card only
              card.querySelectorAll('.ds-snippet-item').forEach(el=>{
                el.addEventListener('click',(e)=>{
                  if(e.target.closest('a')) return;
                  handleSnippetClick(el);
                });
              });
              const btn=card.querySelector('.ds-more-btn');
              if(btn && !btn.dataset.bound){
                btn.dataset.bound='1';
                const label=btn.dataset.moreLabel;
                const hidden=card.querySelector('.ds-hidden-snippets');
                btn.addEventListener('click',(e)=>{
                  e.stopPropagation();
                  e.preventDefault();
                  const exp=card.classList.toggle('ds-expanded');
                  if(hidden) hidden.style.display=exp?'flex':'none';
                  btn.textContent=exp?'Show less':label;
                  if(exp) enableSheetColumnResize(card);
                });
              }
            });
              if(sidePaneEl){ attachCardActionListeners(sidePaneEl); enableSheetColumnResize(sidePaneEl); }
            // update summary counts + progress without rebuilding
            if(summary){
              const filteredInc = filterResultsByPreferences(allSearchResults);
              const totalMatches=filteredInc.reduce((s,d)=>s+d.snippets.length,0);
              const folderNote = (folderScopeActive && curFolder) ? ` in <em>${escapeHtml(getDriveFolderName())}</em>` : '';
              summary.innerHTML=`Found <strong>${totalMatches}</strong> passages in <strong>${filteredInc.length}</strong> files${folderNote}. <span class="ds-still-searching">· scanning ${crawledDocIds.size} files…</span>${prog&&prog.total?`<div class="ds-progress-track"><div class="ds-progress-fill" style="width:${Math.min(100,Math.round(prog.processed/prog.total*100))}%"></div></div>`:''}`;
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
          const curFolder = detectDriveFolder();
          const filteredFinal = filterResultsByPreferences(allSearchResults);
          const totalMatches=filteredFinal.reduce((s,d)=>s+d.snippets.length,0);
          const folderNote = (folderScopeActive && curFolder) ? ` in <em>${escapeHtml(getDriveFolderName())}</em>` : '';
          summary.innerHTML=`Found <strong>${totalMatches}</strong> passages in <strong>${filteredFinal.length}</strong> files${folderNote}.`;
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
let isExactMatch = false;
let isCaseSensitive = false;
let folderScopeActive = false;

let lastKnownFolderId = null;
let lastKnownFolderName = null;

function getDriveFolderName() {
  try {
    const h1 = document.querySelector('h1[data-target="title"], h1, [role="heading"][aria-level="1"]');
    if (h1 && h1.textContent.trim()) {
      const text = h1.textContent.trim();
      if (!text.toLowerCase().includes('google drive') && !text.toLowerCase().includes('search in drive')) {
        return text;
      }
    }
    const crumbs = document.querySelectorAll('[role="navigation"] [role="link"], [data-target="breadcrumb"], [aria-label="Breadcrumbs"] button');
    if (crumbs && crumbs.length > 0) {
      const lastCrumb = crumbs[crumbs.length - 1]?.textContent?.trim();
      if (lastCrumb && !lastCrumb.toLowerCase().includes('drive')) return lastCrumb;
    }
    const title = document.title || '';
    if (title.includes(' - Google Drive')) {
      const clean = title.replace(' - Google Drive', '').trim();
      if (clean && !clean.toLowerCase().includes('search in drive')) return clean;
    }
  } catch (_) {}
  return lastKnownFolderName || 'current folder';
}

function detectDriveFolder() {
  try {
    const p = window.location.pathname || '';
    if (p.includes('/my-drive') || p.includes('/home') || p.includes('/shared-with-me') || p.includes('/recent') || p.includes('/starred') || p.includes('/trash')) {
      lastKnownFolderId = null;
      lastKnownFolderName = null;
      folderScopeActive = false;
      return null;
    }
    const m = p.match(/\/folders\/([a-zA-Z0-9-_]{15,70})/);
    if (m && m[1]) {
      lastKnownFolderId = m[1];
      lastKnownFolderName = getDriveFolderName();
      return m[1];
    }
    const hash = window.location.hash || '';
    const hm = hash.match(/folders\/([a-zA-Z0-9-_]{15,70})/);
    if (hm && hm[1]) {
      lastKnownFolderId = hm[1];
      lastKnownFolderName = getDriveFolderName();
      return hm[1];
    }
    const urlQ = new URLSearchParams(window.location.search).get('q') || '';
    const upm = urlQ.match(/parent:([a-zA-Z0-9-_]{15,70})/i);
    if (upm && upm[1]) {
      lastKnownFolderId = upm[1];
      return upm[1];
    }
    const searchVal = document.querySelector('input[aria-label*="Search"], input[type="search"]')?.value || '';
    const pm = searchVal.match(/parent:([a-zA-Z0-9-_]{15,70})/i);
    if (pm && pm[1]) {
      lastKnownFolderId = pm[1];
      return pm[1];
    }
  } catch (_) {}
  return lastKnownFolderId;
}

function isDocInCurrentFolder(doc, curFolder) {
  if (!curFolder) return true;
  if (doc.folderId) return doc.folderId === curFolder;
  try {
    const currentPath = window.location.pathname || '';
    const currentHash = window.location.hash || '';
    if (currentPath.includes('/folders/' + curFolder) || currentHash.includes('folders/' + curFolder)) {
      doc.folderId = curFolder;
      return true;
    }
    const el = document.querySelector(`[data-id="${doc.id}"]`)
      || document.querySelector(`[data-target="item"][data-id*="${doc.id}"]`)
      || document.querySelector(`a[href*="${doc.id}"]`);
    if (el && !el.closest('#docs-deep-search-pane')) {
      const row = el.closest('tr, [role="row"], [role="gridcell"]') || el.closest('[class*="item"]');
      if (row) {
        const folderLink = row.querySelector(`a[href*="${curFolder}"]`);
        if (folderLink) {
          doc.folderId = curFolder;
          return true;
        }
        if (lastKnownFolderName && lastKnownFolderName !== 'current folder') {
          const rowText = (row.innerText || '').toLowerCase();
          if (rowText.includes(lastKnownFolderName.toLowerCase())) {
            doc.folderId = curFolder;
            return true;
          }
        }
      }
    }
  } catch (_) {}
  return false;
}

function generateSearchDossier(docs, query) {
  const safeDocs = Array.isArray(docs) ? docs : [];
  const q = query || currentQuery || '';
  const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  let totalMatches = 0;
  safeDocs.forEach(d => { totalMatches += (d.snippets ? d.snippets.length : 0); });

  let text = 'PRISM DRIVE SEARCH REPORT\n';
  text += 'Search Term: "' + q + '"\n';
  text += 'Date: ' + dateStr + ' · Matches: ' + totalMatches + ' passage(s) across ' + safeDocs.length + ' file(s)\n';
  text += '────────────────────────────────────────\n\n';

  if (safeDocs.length === 0) {
    text += 'No matching passages found.\n\n';
  } else {
    safeDocs.forEach((doc, idx) => {
      const cat = (docCategory(doc) || 'file').toUpperCase();
      const url = getDriveUrl(doc.id, doc.mimeType, doc.title);
      text += (idx + 1) + '. [' + cat + '] ' + (doc.title || 'Untitled') + '\n';
      text += '   Link: ' + url + '\n';
      if (doc.snippets && doc.snippets.length) {
        doc.snippets.forEach(s => {
          const pass = (s.exactText || s.uiText || '').trim();
          let loc = '';
          if (s.rowIndex) loc = ' (Row ' + s.rowIndex + ')';
          else if (s.matchOffset) loc = ' (Offset ' + s.matchOffset + ')';
          text += '   • "' + pass + '"' + loc + '\n';
        });
      } else {
        text += '   • Title match\n';
      }
      text += '\n';
    });
  }

  text += '────────────────────────────────────────\n';
  text += 'Generated with Prism Deep Drive Search\n';
  return text;
}

function openTabSafe(url) {
  const targetUrl = url || 'https://docs.new';
  let win = null;
  // 1. Synchronously open window during user click gesture (immune to async popup blockers)
  try {
    win = window.open(targetUrl, '_blank');
  } catch (_) {}

  // 2. If blocked or restricted, delegate to background service worker tabs API
  if (!win) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'CREATE_TAB', url: targetUrl });
      }
    } catch (_) {}
  }
}

function copyTextToClipboard(text) {
  if (!text) return Promise.resolve(false);
  // 1. Try synchronous textarea execCommand first (fastest and most reliable within click handler)
  let copied = false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    copied = document.execCommand('copy');
    ta.remove();
  } catch (_) {}

  if (copied) {
    return Promise.resolve(true);
  }

  // 2. Fallback to async navigator.clipboard API
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
    }
  } catch (_) {}
  return Promise.resolve(false);
}

function showSearchToast(message) {
  const existing = document.getElementById('ds-search-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'ds-search-toast';
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483647;
    background: #0f172a;
    color: #f8fafc;
    border: 1px solid rgba(255, 255, 255, 0.16);
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
    padding: 10px 18px;
    border-radius: 8px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif;
    font-size: 12.5px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 8px;
    pointer-events: none;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 0.2s ease, transform 0.2s ease;
  `;
  toast.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg><span>${escapeHtml(message)}</span>`;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

function filterResultsByPreferences(docs) {
  let list = docs || [];
  const curFolder = detectDriveFolder();

  // 1. Filter by Folder if active
  if (folderScopeActive && curFolder) {
    list = list.filter(doc => isDocInCurrentFolder(doc, curFolder));
  }

  // 2. Precision filters (Exact Phrase / Case Sensitive)
  if (!isExactMatch && !isCaseSensitive) {
    return list;
  }

  const q = currentQuery || '';
  const res = [];
  list.forEach(doc => {
    const validSnippets = (doc.snippets || []).filter(s => {
      const txt = s.exactText || s.uiText || '';
      let hay = txt;
      let needle = q;
      if (!isCaseSensitive) {
        hay = hay.toLowerCase();
        needle = needle.toLowerCase();
      }
      return hay.includes(needle);
    });

    let titleMatch = false;
    if (doc.title && q) {
      let tHay = doc.title;
      let tNeedle = q;
      if (!isCaseSensitive) {
        tHay = tHay.toLowerCase();
        tNeedle = tNeedle.toLowerCase();
      }
      titleMatch = tHay.includes(tNeedle);
    }

    if (validSnippets.length > 0) {
      res.push({ ...doc, snippets: validSnippets });
    } else if (titleMatch) {
      res.push(doc);
    }
  });
  return res;
}
const DS_ICONS = {
  all: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
  sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>',
  slide: '<path d="M2 3h20"/><path d="M4 3v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3"/><path d="m12 16 0 5"/><path d="m8 21 4-3 4 3"/>',
  pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 16v-4h2a1.25 1.25 0 0 1 0 2.5H9"/>',
};
function dsTypeIcon(cat){
  const d=DS_ICONS[cat]||DS_ICONS.doc;
  return `<svg class="ds-type-icon ds-ti-${cat}" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}
// Drive-colored file type badges — consistent 18x18 SVG with high DPI alignment
const FILE_BADGE = {
  all: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="2.5" y="2.5" width="19" height="19" rx="4.5" fill="var(--ds-pill-bg)" stroke="var(--ds-border-strong)" stroke-width="1.2"/><path d="m12 6 6 3.5-6 3.5-6-3.5L12 6z" stroke="var(--ds-accent)" stroke-width="1.6" stroke-linejoin="round"/><path d="m6 13 6 3.5 6-3.5" stroke="var(--ds-muted)" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  doc: '<svg width="18" height="18" viewBox="0 0 24 24"><rect x="2.5" y="2.5" width="19" height="19" rx="4.5" fill="#4285F4"/><path d="M7 8h10M7 12h10M7 16h6" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round"/></svg>',
  sheet: '<svg width="18" height="18" viewBox="0 0 24 24"><rect x="2.5" y="2.5" width="19" height="19" rx="4.5" fill="#0F9D58"/><rect x="6.5" y="7" width="11" height="10" rx="1" fill="none" stroke="#ffffff" stroke-width="1.5"/><path d="M6.5 12h11M12 7v10" stroke="#ffffff" stroke-width="1.5"/></svg>',
  slide: '<svg width="18" height="18" viewBox="0 0 24 24"><rect x="2.5" y="2.5" width="19" height="19" rx="4.5" fill="#F4B400"/><rect x="6" y="6.5" width="12" height="8.5" rx="1" fill="none" stroke="#ffffff" stroke-width="1.5"/><path d="M12 15v3.5M9 18.5h6" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/></svg>',
  pdf: '<svg width="18" height="18" viewBox="0 0 24 24"><rect x="2.5" y="2.5" width="19" height="19" rx="4.5" fill="#EA4335"/><path d="M7 6h6.5l3.5 3.5V18H7V6z" fill="none" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/><path d="M9 14.5v-4h2a1 1 0 0 1 0 2H9" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round"/></svg>',
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

const DS_GEM_LOGO = `<img src="${chrome.runtime.getURL('icons/icon48.png')}" width="20" height="20" style="border-radius:5px;display:inline-block;vertical-align:middle;box-shadow:0 1px 4px rgba(0,0,0,0.3);" alt="Prism" onerror="this.outerHTML='<svg width=\\'20\\' height=\\'20\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\'><rect width=\\'24\\' height=\\'24\\' rx=\\'6\\' fill=\\'#0f172a\\'/><path d=\\'M12 4L20 18H4L12 4Z\\' stroke=\\'#38bdf8\\' stroke-width=\\'2\\' fill=\\'rgba(56,189,248,0.2)\\'/></svg>'">`;
const DS_ICON_FILE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
const DS_ICON_LAYERS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>';
const DS_ICON_SEARCH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const DS_ICON_LOCK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

function buildHeaderHTML({icon='',title='Prism',showRefresh=false}={}){
  let premiumBadge = '';
  if (isPremium) {
    premiumBadge = '<span class="ds-premium-badge">PRO</span>';
  } else {
    const displayCount = quotaAllowed ? Math.min(FREE_SEARCH_LIMIT, searchCount) : FREE_SEARCH_LIMIT;
    premiumBadge = `<span class="ds-free-badge" title="Free deep searches">${displayCount} / ${FREE_SEARCH_LIMIT} free used</span>`;
  }
  const upgradeBtn = isPremium
     ? ''
     : `<a href="${UPGRADE_URL}" target="_blank" class="ds-upgrade-btn" id="ds-upgrade-btn">Upgrade</a>`;
  const isDark = shouldUseDarkTheme();
  const themeToggleBtn = `<button class="ds-theme-toggle-btn" id="ds-theme-toggle-btn" title="${isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}" aria-label="Toggle dark mode">
    ${isDark
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`
    }
  </button>`;
  const searchBar = `<div class="ds-pane-search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg><input id="ds-pane-input" readonly placeholder="Search with Drive's search bar above" value="${escapeHtml(currentQuery)}" title="Search from Drive's search bar: results appear here" /></div>`;
  const srcCounts={all:allSearchResults.length,doc:0,sheet:0,slide:0,pdf:0};
  allSearchResults.forEach(d=>{ const c=docCategory(d); if(srcCounts[c]!==undefined) srcCounts[c]++; });
  const srcLabel={all:'All types',doc:'Docs',sheet:'Spreadsheets',slide:'Slides',pdf:'PDFs'}[paneFilter]||'All types';
  const srcItems=[['all','All types'],['doc','Docs'],['sheet','Spreadsheets'],['slide','Slides'],['pdf','PDFs']]
    .map(([k,l])=>`<div class="ds-source-item${paneFilter===k?' active':''}" data-source="${k}"><span class="ds-src-badge">${FILE_BADGE[k]}</span>${l}${srcCounts[k]?`<span class="ds-src-count">${srcCounts[k]}</span>`:''}</div>`).join('');
  const filters = `<div class="ds-filter-row"><div class="ds-filter-select ds-source-filter" id="ds-source-filter" title="Filter by file type"><span class="ds-src-badge">${FILE_BADGE[paneFilter]}</span><span class="ds-source-label">${srcLabel}</span><span class="ds-caret"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span><div class="ds-source-menu" id="ds-source-menu">${srcItems}</div></div></div>`;
  const headerMenu = `<div class="ds-header-menu" id="ds-header-menu"><div class="ds-menu-item" id="ds-menu-rescan"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> Rescan files</div><div class="ds-menu-item" id="ds-menu-license"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> License</div></div>`;
  return `<div class="ds-header"><div class="ds-header-title"><span class="ds-logo-icon">${icon||DS_GEM_LOGO}</span><span>${title}</span>${premiumBadge}</div><div class="ds-header-actions">${upgradeBtn}${themeToggleBtn}<button class="ds-more-btn-icon" id="ds-header-more-btn" title="More options" aria-label="More options"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button><button class="ds-close-btn" id="ds-close-btn" title="Close search pane" aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div></div>${headerMenu}${searchBar}${filters}`;
}

function attachHeaderListeners({showRefresh=false}={}){
  document.getElementById('ds-close-btn')?.addEventListener('click',()=>collapseSidePane());
  document.getElementById('ds-theme-toggle-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const newDark = !shouldUseDarkTheme();
    paneFollowsDark = newDark;
    applyThemeClass();
    try {
      chrome.storage.local.set({ docsDarkMode: newDark });
    } catch (_) {}
  });
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
        ? 'Pro: activated'
        : `Free deep searches used: ${Math.min(FREE_SEARCH_LIMIT, searchCount)} / ${FREE_SEARCH_LIMIT}`
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
  const header = pane.querySelector('.ds-header');
  if (header) header.after(panel);
  else pane.prepend(panel);

  const activateBtn = panel.querySelector('.ds-license-activate-btn');
  const input = panel.querySelector('.ds-license-input');
  panel.addEventListener('click', (e) => e.stopPropagation());
  if (activateBtn && input) {
    activateBtn.addEventListener('click', async (e) => {
      e?.stopPropagation();
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
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); activateBtn.click(); }
    });
    input.addEventListener('keyup', (e) => {
      e.stopPropagation();
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

function renderSampleDulledCards(query) {
  const q = query || 'Project Review';
  return `
    <div class="ds-results-summary">Found <strong>6</strong> passages in <strong>3</strong> files.</div>
    <div class="ds-results-list">
      <div class="ds-doc-card">
        <div class="ds-card-main">
          <div class="ds-thumb-wrap"><span class="ds-thumb-fallback">${FILE_BADGE.doc}</span></div>
          <div class="ds-card-body">
            <div class="ds-doc-title-row">
              <span class="ds-file-badge" title="doc">${FILE_BADGE.doc}</span>
              <span class="ds-doc-title">Operations & Strategy Brief</span>
            </div>
            <div class="ds-snippet-viewer">
              <div class="ds-snippet-item">
                <div class="ds-snippet-pass">
                  <div class="ds-snippet-main">...comprehensive evaluation of deliverables regarding <mark class="ds-highlight">${escapeHtml(q)}</mark> across team milestones...</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="ds-doc-card">
        <div class="ds-card-main">
          <div class="ds-thumb-wrap"><span class="ds-thumb-fallback">${FILE_BADGE.sheet}</span></div>
          <div class="ds-card-body">
            <div class="ds-doc-title-row">
              <span class="ds-file-badge" title="sheet">${FILE_BADGE.sheet}</span>
              <span class="ds-doc-title">2026 Financial Roadmap & Budget</span>
            </div>
            <div class="ds-snippet-viewer">
              <div class="ds-snippet-item">
                <div class="ds-snippet-pass">
                  <div class="ds-snippet-main">...Row 34: Strategic expenditures allocated toward <mark class="ds-highlight">${escapeHtml(q)}</mark> objectives...</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="ds-doc-card">
        <div class="ds-card-main">
          <div class="ds-thumb-wrap"><span class="ds-thumb-fallback">${FILE_BADGE.pdf}</span></div>
          <div class="ds-card-body">
            <div class="ds-doc-title-row">
              <span class="ds-file-badge" title="pdf">${FILE_BADGE.pdf}</span>
              <span class="ds-doc-title">Executive Proposal_Final.pdf</span>
            </div>
            <div class="ds-snippet-viewer">
              <div class="ds-snippet-item">
                <div class="ds-snippet-pass">
                  <div class="ds-snippet-main">...Page 2: Summary findings highlighting <mark class="ds-highlight">${escapeHtml(q)}</mark> recommendations...</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function showPaywall(customMsg) {
  if (!searchEnabled) {
    hideSidePane();
    return;
  }
  isWaitingForResults = false;
  isScanningDocuments = false;
  if (scanTimeout) clearTimeout(scanTimeout);
  if (loadTimeout) clearTimeout(loadTimeout);
  if (emptyResultsTimer) clearTimeout(emptyResultsTimer);
  emptyResultsTimer = null;

  const pane = getOrCreateSidePane();
  expandSidePane();

  const existingCard = pane.querySelector('.ds-paywall-card');
  if (existingCard) {
    if (customMsg) {
      const sub = existingCard.querySelector('.ds-paywall-sub');
      if (sub) sub.textContent = customMsg;
    }
    return;
  }

  const dulledCardsHtml = allSearchResults && allSearchResults.length > 0
    ? `<div class="ds-results-list">${allSearchResults.slice(0, 5).map(renderDocCard).join('')}</div>`
    : renderSampleDulledCards(currentQuery);

  const paywallCardHtml = `
    <div class="ds-dulled-wrapper">
      <div class="ds-dulled-content">
        ${dulledCardsHtml}
      </div>
      <div class="ds-dulled-overlay">
        <div class="ds-paywall-card">
          <div class="ds-quota-badge">${FREE_SEARCH_LIMIT} / ${FREE_SEARCH_LIMIT} FREE SEARCHES USED</div>
          <div class="ds-paywall-icon">${DS_ICON_LOCK}</div>
          <h3>Free Search Limit Reached</h3>
          <p class="ds-paywall-sub">${customMsg || `You have used your ${FREE_SEARCH_LIMIT} free deep Drive searches. Upgrade to Pro for unlimited search.`}</p>
          <div class="ds-paywall-actions">
            <a href="${UPGRADE_URL}" target="_blank" class="ds-paywall-btn primary" id="ds-paywall-upgrade-btn">Upgrade to Pro ($49/yr) →</a>
            <button type="button" class="ds-paywall-btn secondary" id="ds-enter-key-btn">Enter License Key</button>
          </div>
          <div class="ds-license-panel" id="ds-license-panel" style="display:none; width:100%; margin-top:12px; text-align:left;">
            <div class="ds-license-input-row" style="display:flex; gap:6px;">
              <input type="text" class="ds-license-input" placeholder="PRISM-XXXX-XXXX" spellcheck="false" style="flex:1; padding:6px 10px; border-radius:6px; border:1px solid var(--ds-border-strong); background:var(--ds-bg-2); color:var(--ds-text); font-size:12px;" />
              <button class="ds-license-activate-btn" style="padding:6px 12px; border-radius:6px; background:var(--ds-accent); color:#fff; border:none; font-weight:600; font-size:12px; cursor:pointer;">Activate</button>
            </div>
            <div class="ds-license-error" id="ds-license-error" style="color:#ef4444; font-size:11px; margin-top:4px;"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  pane.innerHTML = `${buildHeaderHTML({title:'Drive Deep Search', showRefresh:false})}<div class="ds-content">${paywallCardHtml}</div>`;
  attachHeaderListeners({showRefresh:false});
  ensureHandleExists(pane);

  const enterKeyBtn = document.getElementById('ds-enter-key-btn');
  const licensePanel = document.getElementById('ds-license-panel');
  if (enterKeyBtn && licensePanel) {
    enterKeyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = licensePanel.style.display === 'none';
      licensePanel.style.display = isHidden ? 'block' : 'none';
      enterKeyBtn.textContent = isHidden ? 'Hide License Input' : 'Enter License Key';
      if (isHidden) {
        const inp = licensePanel.querySelector('.ds-license-input');
        if (inp) inp.focus();
      }
    });

    licensePanel.addEventListener('click', (e) => e.stopPropagation());

    const activateBtn = licensePanel.querySelector('.ds-license-activate-btn');
    const input = licensePanel.querySelector('.ds-license-input');
    if (activateBtn && input) {
      activateBtn.addEventListener('click', async (e) => {
        e?.stopPropagation();
        const key = input.value.trim();
        if (!key) return;
        activateBtn.textContent = 'Checking...';
        activateBtn.disabled = true;
        const result = await validateLicenseKey(key);
        if (result.valid) {
          isPremium = true;
          quotaAllowed = true;
          if (currentQuery) {
            resetScan();
            waitForResultsToLoad();
          } else {
            renderResults(allSearchResults, { stillSearching: false });
          }
        } else {
          const err = document.getElementById('ds-license-error');
          if (err) err.textContent = result.error || 'Invalid key';
          activateBtn.textContent = 'Activate';
          activateBtn.disabled = false;
        }
      });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          activateBtn.click();
        }
      });
      input.addEventListener('keyup', (e) => {
        e.stopPropagation();
      });
    }
  }
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
function renderPaneFilterBar(baseDocs = allSearchResults){
  const filtered = filterResultsByPreferences(baseDocs);
  const counts={all:filtered.length,doc:0,sheet:0,slide:0,pdf:0};
  filtered.forEach(d=>{ const c=docCategory(d); if(counts[c]!==undefined) counts[c]++; });
  const curFolder = detectDriveFolder();
  const chips=[['all','All'],['doc','Docs'],['sheet','Sheets'],['slide','Slides'],['pdf','PDFs']]
    .filter(([k])=>k==='all'||counts[k]>0||paneFilter===k)
    .map(([k,label])=>`<button class="ds-filter-chip${paneFilter===k?' active':''}" data-filter="${k}">${dsTypeIcon(k)}${label}${counts[k]?`<span class="ds-chip-count" data-count="${k}">${counts[k]}</span>`:''}</button>`)
    .join('');
  const tools = `
    <div class="ds-toolbar-row">
      <div class="ds-toolbar-chips">
        <button type="button" class="ds-tool-chip${isExactMatch?' active':''}" id="ds-toggle-exact" title="Match exact verbatim phrase">
          <span class="ds-tool-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.75-2-2-2H4c-1.25 0-2 .75-2 2v6c0 1.25.75 2 2 2h4c0 4-2 6-5 6v2zm14 0c3 0 7-1 7-8V5c0-1.25-.75-2-2-2h-4c-1.25 0-2 .75-2 2v6c0 1.25.75 2 2 2h4c0 4-2 6-5 6v2z"/></svg></span> Exact Phrase
        </button>
        <button type="button" class="ds-tool-chip${isCaseSensitive?' active':''}" id="ds-toggle-case" title="Case-sensitive search">
          <span class="ds-tool-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 16 4.5-9 4.5 9"/><path d="M4.5 13h6"/><path d="M18 12a3 3 0 1 0 0 6 3 3 0 0 0 3-3v-5"/><path d="M21 15h-3"/></svg></span> Match Case
        </button>
        ${curFolder ? `<button type="button" class="ds-tool-chip${folderScopeActive?' active':''}" id="ds-toggle-folder" title="Filter search to &quot;${escapeHtml(getDriveFolderName())}&quot;"><span class="ds-tool-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span> In Folder${folderScopeActive ? ` (${escapeHtml(getDriveFolderName().slice(0, 16))})` : ''}</button>` : ''}
      </div>
    </div>
  `;
  return `<div class="ds-filters">${chips}</div>${tools}`;
}
function updatePaneFilterCounts(){
  if(!sidePaneEl) return;
  const filtered = filterResultsByPreferences(allSearchResults);
  const counts={all:filtered.length,doc:0,sheet:0,slide:0,pdf:0};
  filtered.forEach(d=>{ const c=docCategory(d); if(counts[c]!==undefined) counts[c]++; });
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
  if (!searchEnabled) { hideSidePane(); return; }
  if (!canSearch()) { showPaywall(); return; }
  const pane=getOrCreateSidePane();
  const prev=pane.querySelector('.ds-content');
  const prevScroll=prev?prev.scrollTop:0;
  const expanded=new Set([...pane.querySelectorAll('.ds-doc-card.ds-expanded')].map(el=>el.dataset.docId));
  const filteredResults = filterResultsByPreferences(results);
  const totalMatches=filteredResults.reduce((s,d)=>s+d.snippets.length,0);
  const curFolder=detectDriveFolder();
  let html='';
  if(totalMatches===0){
    if(isScanningDocuments){ showSidePaneLoading('Scanning… no matches yet'); return; }
    const emptyDesc = (folderScopeActive && curFolder && allSearchResults.length > 0)
      ? `Found ${allSearchResults.length} match(es) in other locations, but none inside "${escapeHtml(getDriveFolderName())}". Click "In Folder" above to show all results.`
      : `Scanned ${crawledDocIds.size} files. No passage matched ${formatQueryForDisplay(currentQuery)}${isExactMatch ? ' (Exact Phrase filter active)' : ''}.`;
    html=`${renderPaneFilterBar()}<div class="ds-empty-state"><div class="ds-empty-icon">${DS_ICON_FILE}</div><h3>No matches inside files</h3><p>${emptyDesc}</p></div>`;
  } else {
    const shown=paneFilter==='all'?filteredResults:filteredResults.filter(d=>docCategory(d)===paneFilter);
    const shownMatches=shown.reduce((s,d)=>s+d.snippets.length,0);
    const note=stillSearching?` <span class="ds-still-searching">· scanning ${crawledDocIds.size} files…</span>`:'';
    const bar=(stillSearching&&progress&&progress.total>0)?`<div class="ds-progress-track"><div class="ds-progress-fill" style="width:${Math.min(100,Math.round(progress.processed/progress.total*100))}%"></div></div>`:'';
    const exportBar = `
      <div class="ds-export-toolbar">
        <span class="ds-export-label">Export:</span>
        <button type="button" class="ds-export-btn" id="ds-copy-all-btn" title="Copy all matches and file links to clipboard">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span>Copy All</span>
        </button>
        <button type="button" class="ds-export-btn primary" id="ds-download-btn" title="Download compiled search report (.txt)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>Download Report</span>
        </button>
      </div>
    `;
    const scrollHint = !stillSearching && discoveredDocs.length > crawledDocIds.size
      ? `<div class="ds-scroll-hint">Scroll down in Drive to load more files for Prism to scan.</div>`
      : '';
    const listHtml=shown.length
      ?`<div class="ds-results-list">${shown.map(renderDocCard).join('')}</div>${scrollHint}`
      :`<div class="ds-empty-state"><div class="ds-empty-icon">${DS_ICON_LAYERS}</div><h3>No ${paneFilter} matches</h3><p>${totalMatches} match${totalMatches===1?'':'es'} found in other file types. Try the "All" filter or a different category.</p></div>`;
    const folderNote = (folderScopeActive && curFolder) ? ` in <em>${escapeHtml(getDriveFolderName())}</em>` : '';
    html=`${renderPaneFilterBar()}<div class="ds-results-summary">${paneFilter==='all'?`<strong>${totalMatches}</strong> match${totalMatches===1?'':'es'} across <strong>${filteredResults.length}</strong> file${filteredResults.length===1?'':'s'}${folderNote} — click any passage to jump`:`<strong>${shownMatches}</strong> match${shownMatches===1?'':'es'} in <strong>${shown.length}</strong> ${paneFilter} file${shown.length===1?'':'s'}${folderNote}`}${note}${bar}</div>${exportBar}<div class="ds-search-hint">Searching inside your files for <strong>${formatQueryForDisplay(currentQuery)}</strong> — use Drive's search bar above to change the term.</div>${listHtml}`;
  }
  pane.innerHTML=`${buildHeaderHTML({showRefresh:true})}<div class="ds-content">${html}</div>`;
  attachHeaderListeners({showRefresh:true});
  attachFilterListeners(pane);

  // Precision tool listeners
  document.getElementById('ds-toggle-exact')?.addEventListener('click', (e) => {
    e.stopPropagation();
    isExactMatch = !isExactMatch;
    renderResults(allSearchResults, { stillSearching: isScanningDocuments });
  });
  document.getElementById('ds-toggle-case')?.addEventListener('click', (e) => {
    e.stopPropagation();
    isCaseSensitive = !isCaseSensitive;
    renderResults(allSearchResults, { stillSearching: isScanningDocuments });
  });
  document.getElementById('ds-toggle-folder')?.addEventListener('click', (e) => {
    e.stopPropagation();
    folderScopeActive = !folderScopeActive;
    renderResults(allSearchResults, { stillSearching: isScanningDocuments });
  });

  // Export dossier listeners
  const copyAllBtn = document.getElementById('ds-copy-all-btn');
  if (copyAllBtn) {
    copyAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentList = (paneFilter === 'all' ? filteredResults : filteredResults.filter(d => docCategory(d) === paneFilter)) || [];
      const dossier = generateSearchDossier(currentList, currentQuery);
      copyTextToClipboard(dossier).then(() => {
        const orig = copyAllBtn.innerHTML;
        copyAllBtn.innerHTML = '<span>Copied All Matches ✓</span>';
        copyAllBtn.classList.add('copied');
        showSearchToast('All search matches copied to clipboard!');
        setTimeout(() => {
          copyAllBtn.innerHTML = orig;
          copyAllBtn.classList.remove('copied');
        }, 2200);
      });
    });
  }

  const downloadBtn = document.getElementById('ds-download-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentList = (paneFilter === 'all' ? filteredResults : filteredResults.filter(d => docCategory(d) === paneFilter)) || [];
      const dossier = generateSearchDossier(currentList, currentQuery);
      try {
        const blob = new Blob([dossier], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const slug = (currentQuery || 'search').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
        a.download = `prism-report-${slug}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        showSearchToast('Downloaded search report text file!');
      } catch (_) {
        copyTextToClipboard(dossier);
        showSearchToast('Report copied to clipboard!');
      }
    });
  }


  // pane search field is read-only — it mirrors Drive's search term (full search happens in Drive's bar)
  // rich actions: Open / Copy / menu
  attachCardActionListeners(pane);
  pane.querySelectorAll('.ds-snippet-item').forEach(el=>{
    el.addEventListener('click',(e)=>{
      if (e.target.closest('a')) return;
      handleSnippetClick(el);
    });
  });
  enableSheetColumnResize(pane);

  if(expanded.size>0){
    pane.querySelectorAll('.ds-doc-card').forEach(c=>{
      if(expanded.has(c.dataset.docId)){
        c.classList.add('ds-expanded');
        const b=c.querySelector('.ds-more-btn'); if(b) b.textContent='Show less';
        const h=c.querySelector('.ds-hidden-snippets'); if(h) h.style.display='flex';
      }
    });
  }
  const nc=pane.querySelector('.ds-content');
  if(nc && prevScroll>0) nc.scrollTop=prevScroll;
  pane.querySelectorAll('.ds-doc-card').forEach(card=>{
    const btn=card.querySelector('.ds-more-btn'); if(!btn || btn.dataset.bound) return;
    btn.dataset.bound='1';
    const label=btn.dataset.moreLabel;
    const hidden=card.querySelector('.ds-hidden-snippets');
    btn.addEventListener('click',(e)=>{
      e.stopPropagation();
      e.preventDefault();
      const exp=card.classList.toggle('ds-expanded');
      if(hidden) hidden.style.display=exp?'flex':'none';
      btn.textContent=exp?'Show less':label;
      if(exp) enableSheetColumnResize(card);
    });
  });
  ensureHandleExists(pane);
}
function renderDocCard(doc){
  const cat=docCategory(doc);
  const total=doc.snippets.length;
  const jumpLabel = cat==='sheet' ? 'Open at row' : (cat==='pdf' ? 'Jump to match' : 'Jump to paragraph');
  const firstSnip = doc.snippets[0] || {};
  const firstOffset = firstSnip.matchOffset || firstSnip.offset || 0;
  const firstPage = getSnippetPageNumber(firstSnip);
  const actionsHtml = `<div class="ds-actions"><button class="ds-btn primary" data-action="open" data-doc-id="${doc.id}" data-mime="${escapeHtml(doc.mimeType||'')}" data-exact="${escapeHtml(firstSnip.exactText||'')}" data-kw="${escapeHtml(firstSnip.keyword||currentQuery||'')}" data-offset="${firstOffset}" data-page="${firstPage}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg> ${jumpLabel}</button></div>`;
  const matchBadge = total > 1 ? `<span class="ds-match-count">${total} matches</span>` : '';
  const titleRow = `<div class="ds-doc-title-row"><span class="ds-file-badge" title="${cat}">${FILE_BADGE[cat]||FILE_BADGE.doc}</span><a href="${getDriveUrl(doc.id, doc.mimeType, doc.title)}" target="_blank" class="ds-doc-title">${escapeHtml(doc.title)}</a>${matchBadge}<button class="ds-doc-menu" data-menu="${doc.id}" title="More">&#8942;</button><div class="ds-doc-menu-dropdown" id="menu-${doc.id}"><div class="ds-menu-item" data-menu-action="copy" data-doc-id="${doc.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy snippet</div><div class="ds-menu-item" data-menu-action="context" data-doc-id="${doc.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg> View in context</div></div></div>`;
  const thumbUrl = `https://drive.google.com/thumbnail?id=${encodeURIComponent(doc.id)}&sz=w200`;
  const thumbHtml = `<div class="ds-thumb-wrap"><img class="ds-thumb" src="${thumbUrl}" loading="lazy" alt="" data-thumb><span class="ds-thumb-fallback">${FILE_BADGE[cat]||FILE_BADGE.doc}</span></div>`;
  const MAX_VISIBLE = 2;
  const visibleSnips = doc.snippets.slice(0, MAX_VISIBLE);
  const hiddenSnips = doc.snippets.slice(MAX_VISIBLE);
  const visibleHtml = visibleSnips.map(s=>renderSnippet(doc.id,s,cat,doc.mimeType,doc.title)).join('');
  const hiddenHtml = hiddenSnips.length
    ? `<div class="ds-hidden-snippets">${hiddenSnips.map(s=>renderSnippet(doc.id,s,cat,doc.mimeType,doc.title)).join('')}</div>`
    : '';
  const moreBtn = hiddenSnips.length
    ? `<button class="ds-more-btn" data-more-label="Show ${hiddenSnips.length} more match${hiddenSnips.length===1?'':'es'}">Show ${hiddenSnips.length} more match${hiddenSnips.length===1?'':'es'}</button>`
    : '';
  return `<div class="ds-doc-card" data-doc-id="${doc.id}" data-cat="${cat}"><div class="ds-card-main">${thumbHtml}<div class="ds-card-body">${titleRow}<div class="ds-snippet-list">${visibleHtml}${hiddenHtml}${moreBtn}</div>${actionsHtml}</div></div></div>`;
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
      const kw=btn.dataset.kw||'';
      const offset=parseInt(btn.dataset.offset||'0', 10);
      const page=parseInt(btn.dataset.page||'1', 10);
      const card=btn.closest('.ds-doc-card'); const cat=card?.dataset.cat||'';

      const driveUrl = getDriveUrl(id, mime, '');
      const isDrivePreview = driveUrl.includes('drive.google.com/file/d/');

      if(cat==='sheet'){
        const snipEl=card?.querySelector('.ds-snippet-item');
        const row=snipEl?.dataset.row||'';
        const kwVal=snipEl?.dataset.keyword||kw;
        openSheetMatch(id, mime, row, kwVal||txt);
      } else if(cat==='slide'){
        const snipEl=card?.querySelector('.ds-snippet-item');
        const targetPage = page > 1 ? page : parseInt(snipEl?.dataset.page||'1', 10);
        let url = `https://docs.google.com/presentation/d/${id}/edit#slide=id.p${targetPage}`;
        if(txt) url += `&find-text=${encodeURIComponent(txt.slice(0, 60))}`;
        window.open(url, '_blank');
      } else if(cat==='doc' && !isDrivePreview){
        let url = `https://docs.google.com/document/d/${id}/edit#find-text=${encodeURIComponent(txt)}`;
        if(kw) url += `&kw=${encodeURIComponent(kw)}`;
        window.open(url, '_blank');
      } else {
        const snipEl=card?.querySelector('.ds-snippet-item');
        const finalPage = page > 1 ? page : (snipEl ? parseInt(snipEl.dataset.page||'1', 10) : 1);
        const finalOffset = offset || (snipEl ? parseInt(snipEl.dataset.offset||'0', 10) : 0);
        const finalTxt = txt || snipEl?.dataset.exactText || '';
        const finalKw = kw || snipEl?.dataset.keyword || currentQuery || '';
        openPdfMatch(id, mime, finalTxt, finalKw, finalOffset, finalPage);
      }
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
      const snipEl = card?.querySelector('.ds-snippet-item');
      const snippet = snipEl?.dataset.exactText || snipEl?.innerText?.trim() || '';
      const docTitle = card?.querySelector('.ds-doc-title')?.textContent?.trim() || 'Document';
      const docLink = card?.querySelector('.ds-doc-title')?.href || getDriveUrl(docId, snipEl?.dataset.mime||'', docTitle);
      card?.classList.remove('menu-open');

      if(action==='context'){
        if (snipEl) {
          handleSnippetClick(snipEl);
        } else {
          const mime=snipEl?.dataset.mime||'';
          let url=getDriveUrl(docId, mime, docTitle);
          openTabSafe(url);
        }

      } else if(action==='annotate'){
        copyTextToClipboard(snippet);
        showSearchToast('Snippet copied! (In-document annotation coming soon)');
      }
    });
  });
  // Copy snippet from ⋮ menu
  scope.querySelectorAll('.ds-menu-item[data-menu-action="copy"]:not([data-init])').forEach(item=>{
    item.dataset.init='1';
    item.addEventListener('click', (e)=>{
      e.stopPropagation();
      const docId=item.dataset.docId;
      const card=scope.querySelector(`.ds-doc-card[data-doc-id="${docId}"]`);
      card?.classList.remove('menu-open');
      const snipEl = card?.querySelector('.ds-snippet-item');
      const snippet = snipEl?.dataset.exactText || snipEl?.innerText?.trim() || '';
      if(!snippet) return;
      copyTextToClipboard(snippet).then(()=>{
        item.textContent='Copied ✓';
        showSearchToast('Snippet copied to clipboard!');
        setTimeout(()=>{ item.innerHTML=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy snippet`; }, 1500);
      });
    });
  });

}

function enableSheetColumnResize(pane){
  pane.querySelectorAll('.ds-sheet-table').forEach(table=>{
    const hit = table.querySelector('.ds-cell-hit');
    if(hit){
      setTimeout(()=>{
        const left = hit.offsetLeft;
        if(left > 160){
          table.scrollLeft = Math.max(0, left - 100);
        }
      }, 50);
    }
  });
}
function renderSnippet(docId, snip, cat, mime, docTitle){
  if(snip.isTitleMatch){
    const src = escapeHtml(docTitle||snip.exactText||'');
    const href=getDriveUrl(docId,mime,docTitle);
    return `<div class="ds-snippet-item ds-title-match" data-doc-id="${docId}" data-exact-text="${escapeHtml(snip.exactText)}" data-keyword="${escapeHtml(snip.keyword||currentQuery||'')}" data-cat="${cat}" data-mime="${escapeHtml(mime||'')}" title="Title match — open file"><div class="ds-snippet-pass"><div class="ds-title-badge">Title match</div><div class="ds-snippet-main">${highlightKeyword(src, snip.keyword)}</div></div><div class="ds-snippet-source"><span class="ds-src-badge">${FILE_BADGE[cat]||''}</span><a href="${href}" target="_blank">${src.slice(0,28)}</a><span class="ds-page-chip">Title</span></div></div>`;
  }
  const pageIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
  const snipOffset = snip.matchOffset || snip.offset || 0;
  const snipPage = getSnippetPageNumber(snip);
  let page;
  if(cat==='sheet') page=`Row ${snip.rowIndex??'?'}`;
  else if(cat==='slide') page=`Slide ${snipPage}`;
  else page=`Page ${snipPage}`;
  const src = docTitle ? escapeHtml(docTitle.slice(0,28))+(docTitle.length>28?'...':'') : '';
  const sourceLine=(href)=>`<div class="ds-snippet-source"><span class="ds-src-badge">${FILE_BADGE[cat]||''}</span>${href?`<a href="${href}" target="_blank">${src||'Open in Drive'}</a>`:`<span>${src}</span>`}<span class="ds-page-chip">${pageIcon} ${page}</span></div>`;
  if(cat==='sheet'){
    const kw=(snip.keyword||'').toLowerCase();
    const rNum = snip.rowIndex || 0;

    const cleanCell = (c) => {
      let s = (c || '').trim();
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1).trim();
      }
      return s;
    };

    const splitCells = (line) => {
      if (!line) return [];
      let cells;
      if (line.includes('\t')) cells = line.split('\t');
      else if (line.includes(',')) cells = parseCsvCells(line);
      else cells = [line];
      return cells.map(cleanCell);
    };

    const headerCells = splitCells(snip.header);
    const beforeCells = splitCells(snip.before);
    const matchCells = splitCells(snip.exactText || snip.uiText || '');
    const afterCells = splitCells(snip.after);

    const maxCols = Math.max(headerCells.length, beforeCells.length, matchCells.length, afterCells.length);
    const numCols = Math.min(Math.max(maxCols, 1), 16);

    const renderCells = (cells, isHeader, isMatch) => {
      let tds = '';
      for (let c = 0; c < numCols; c++) {
        const val = cells[c] || '';
        const isHit = !isHeader && kw && val.toLowerCase().includes(kw);
        const tag = isHeader ? 'th' : 'td';
        const hitCls = isHit ? ' ds-cell-hit' : '';
        const displayVal = isHeader ? `<b>${escapeHtml(val || `Col ${c+1}`)}</b>` : (isHit ? highlightKeyword(val, snip.keyword) : escapeHtml(val));
        tds += `<${tag} class="ds-sheet-cell${hitCls}" title="${escapeHtml(val)}" data-col="${c}">${displayVal}</${tag}>`;
      }
      return tds;
    };

    let tableHtml = '<div class="ds-sheet-table"><table class="ds-sheet-grid">';
    if (headerCells.length) {
      tableHtml += `<tr class="ds-sheet-row ds-sheet-header"><th class="ds-sheet-cell ds-row-num">#</th>${renderCells(headerCells, true, false)}</tr>`;
    }
    if (beforeCells.length && rNum > 2) {
      tableHtml += `<tr class="ds-sheet-row"><td class="ds-sheet-cell ds-row-num">${rNum - 1}</td>${renderCells(beforeCells, false, false)}</tr>`;
    }
    if (matchCells.length) {
      tableHtml += `<tr class="ds-sheet-row ds-sheet-match"><td class="ds-sheet-cell ds-row-num ds-match-num">${rNum ? `${rNum} ▶` : '▶'}</td>${renderCells(matchCells, false, true)}</tr>`;
    }
    if (afterCells.length) {
      tableHtml += `<tr class="ds-sheet-row"><td class="ds-sheet-cell ds-row-num">${rNum ? rNum + 1 : ''}</td>${renderCells(afterCells, false, false)}</tr>`;
    }
    tableHtml += '</table></div>';

    return `<div class="ds-snippet-item ds-sheet-snippet" data-doc-id="${docId}" data-exact-text="${escapeHtml(snip.exactText)}" data-keyword="${escapeHtml(snip.keyword||currentQuery||'')}" data-cat="${cat}" data-mime="${escapeHtml(mime||'')}" data-row="${snip.rowIndex||''}" title="Click to open at row ${snip.rowIndex||''}">${tableHtml}${sourceLine(getDriveUrl(docId,mime,docTitle))}</div>`;
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
  return `<div class="ds-snippet-item" data-doc-id="${docId}" data-exact-text="${escapeHtml(snip.exactText)}" data-keyword="${escapeHtml(snip.keyword||currentQuery||'')}" data-offset="${snipOffset}" data-page="${snipPage}" data-cat="${cat}" data-mime="${escapeHtml(mime||'')}" title="Open at this passage">${body}${sourceLine(getDriveUrl(docId,mime,docTitle))}</div>`;
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
