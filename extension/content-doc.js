// Content Script for Google Docs Editor Page
// Handles deep-linking, native-Find search, and Image-Safe Dark Mode
// with full color palette, image inversion toggle, and header styling.

// ==========================================
// Google Docs Dark Mode (Image-Safe Engine)
// ==========================================

// Preset dark background colors for the color palette
const DARK_PRESETS = [
  { label: 'Graphite',  color: '#1e1f20' },
  { label: 'Obsidian',  color: '#121212' },
  { label: 'Abyss',     color: '#0d1117' },
  { label: 'Midnight',  color: '#1a1b2e' },
  { label: 'Espresso',  color: '#1c1008' },
  { label: 'Forest',    color: '#0d1f12' },
  { label: 'Navy',      color: '#0a0e1a' },
  { label: 'Slate',     color: '#1e2430' },
];

let isDocsDarkMode = true;
let darkColor = '#1a1a1a';        // Theme color (outer page + chrome)
let hasCustomBg = false;          // true once the user picks a Theme color
let docColor = '#2b2f36';         // document editor sheet (separate setting)
let textColorSetting = '#e2e8f0'; // main text color (separate setting)
// DocsAfterDark-style options
let darkVariant = 'midnight';     // Midnight only (Normal removed)
let accentHue = 225;              // 0â€“360
let showBorder = true;
let showQuickToggle = true;
let instantRepaint = false;
// Per-surface switches. Docs documents are always themed (the core engine);
// every other surface can be left to the browser (e.g. Edge's auto-dark flag)
// to avoid double-darkening. Extensions cannot read edge://flags, so this is
// a manual switch per surface.
let surfaces = { sheets: true, drive: true, docshome: true };

// 1 default, polished dark mode theme is 100% free forever for all users.
// Custom color palettes, doc sheets, text colors & accent hues are Pro-only.
const DEFAULT_DARK_COLOR = '#1a1a1a';
const DEFAULT_DOC_COLOR = '#2b2f36';
const DEFAULT_TEXT_COLOR = '#e2e8f0';
const DEFAULT_ACCENT_HUE = 225;

let darkIsPremium = false;
let darkLicenseExpiresAt = 0;

function darkEnabled() {
  if (!isDocsDarkMode) return false;
  const a = detectApp();
  if (a === 'utility' || a === 'slides' || a === 'preview') return false;
  if (a === 'docs') return true;
  return surfaces[a] !== false;
}

// Read preferences immediately at document_start to avoid white flash
const PRISM_KEYS = ['docsDarkMode', 'docsDarkColor', 'docsDocColor', 'docsTextColor', 'docsAccentHue', 'docsShowBorder', 'docsShowQuickToggle', 'docsInstantRepaint', 'docsSurfaces', 'isPro', 'prismPremium', 'prismLicenseExpiresAt'];

function readAndApply() {
  try {
    chrome.storage.local.get(PRISM_KEYS, (res) => {
      snapshotFromStorage(res);
    });
  } catch (e) {
    try { applyDarkMode(darkEnabled()); } catch (_) {}
  }
}

// Signature of the currently applied settings â€” used to detect changes that
// landed while the tab was hidden (the popup writes colors while Docs sits
// in the background, and storage events can be delayed for hidden tabs).
function prismSettingsSig() {
  return [isDocsDarkMode, darkColor, hasCustomBg, docColor, textColorSetting,
    accentHue, showBorder, showQuickToggle, instantRepaint,
    darkIsPremium, JSON.stringify(surfaces)].join('|');
}
function prismResSig(res) {
  const surf = { ...surfaces, ...(res.docsSurfaces || {}) };
  return [res.docsDarkMode !== false,
    res.docsDarkColor || '#1a1a1a',
    !!res.docsDarkColor,
    res.docsDocColor || '#2b2f36',
    res.docsTextColor || '#e2e8f0',
    Number.isFinite(+res.docsAccentHue) ? +res.docsAccentHue : 225,
    res.docsShowBorder !== false,
    res.docsShowQuickToggle !== false,
    res.docsInstantRepaint === true,
    !!(res.isPro || res.prismPremium),
    res.prismLicenseExpiresAt || 0,
    JSON.stringify(surf)].join('|');
}
let prismLastSig = '';

function snapshotFromStorage(res) {
  isDocsDarkMode = res.docsDarkMode !== false;
  darkIsPremium = !!(res.isPro || res.prismPremium) && (!res.prismLicenseExpiresAt || Date.now() < res.prismLicenseExpiresAt);

  if (!darkIsPremium) {
    darkColor = DEFAULT_DARK_COLOR;
    hasCustomBg = true;
    docColor = DEFAULT_DOC_COLOR;
    textColorSetting = DEFAULT_TEXT_COLOR;
    accentHue = DEFAULT_ACCENT_HUE;
  } else {
    darkColor = res.docsDarkColor || DEFAULT_DARK_COLOR;
    hasCustomBg = true;
    docColor = res.docsDocColor || DEFAULT_DOC_COLOR;
    textColorSetting = res.docsTextColor || DEFAULT_TEXT_COLOR;
    accentHue = Number.isFinite(+res.docsAccentHue) ? +res.docsAccentHue : DEFAULT_ACCENT_HUE;
  }

  showBorder = res.docsShowBorder !== false;
  showQuickToggle = res.docsShowQuickToggle !== false;
  instantRepaint = res.docsInstantRepaint === true;
  if (res.docsSurfaces) surfaces = { ...surfaces, ...res.docsSurfaces };
  prismLastSig = prismSettingsSig();

  applyDarkMode(darkEnabled());
  injectQuickToggleButton();
}

readAndApply();

// SPA navigation (e.g. Docs home list â†’ document) doesn't re-run content
// scripts, so the theme would stay stuck on the previous surface. Re-sync
// whenever the URL changes.
let lastPrismUrl = '';
try { lastPrismUrl = window.location.href; } catch (_) {}
setInterval(() => {
  try {
    if (window.location.href !== lastPrismUrl) {
      lastPrismUrl = window.location.href;
      readAndApply();
      const a = detectApp();
      if (a === 'docs') initDeepLink();
      else if (a === 'sheets') initSheetDeepLink();
      else if (a === 'preview' || a === 'drive') initPdfDeepLink();
    }
  } catch (_) {}
}, 1000);

// Listen for settings changes from popup or storage
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  let changed = false;
  if (changes.docsDarkMode) {
    isDocsDarkMode = changes.docsDarkMode.newValue !== false;
    changed = true;
  }
  if (changes.docsDarkColor) {
    darkColor = changes.docsDarkColor.newValue || '#1a1a1a';
    hasCustomBg = !!changes.docsDarkColor.newValue;
    changed = true;
  }
  if (changes.docsDocColor) {
    docColor = changes.docsDocColor.newValue || '#2b2f36';
    changed = true;
  }
  if (changes.docsTextColor) {
    textColorSetting = changes.docsTextColor.newValue || '#e2e8f0';
    changed = true;
  }
  if (changes.docsAccentHue) {
    accentHue = Number.isFinite(+changes.docsAccentHue.newValue) ? +changes.docsAccentHue.newValue : 225;
    changed = true;
  }
  if (changes.docsShowBorder) {
    showBorder = changes.docsShowBorder.newValue !== false;
    changed = true;
  }
  if (changes.docsShowQuickToggle) {
    showQuickToggle = changes.docsShowQuickToggle.newValue !== false;
    changed = true;
  }
  if (changes.docsInstantRepaint) {
    instantRepaint = changes.docsInstantRepaint.newValue === true;
    changed = true;
  }
  if (changes.docsSurfaces) {
    surfaces = { ...surfaces, ...changes.docsSurfaces.newValue };
    changed = true;
  }
  if (changes.isPro || changes.prismPremium) {
    darkIsPremium = !!(changes.isPro?.newValue || changes.prismPremium?.newValue);
    changed = true;
  }
  if (changes.prismLicenseExpiresAt) {
    darkLicenseExpiresAt = Number(changes.prismLicenseExpiresAt.newValue) || 0;
    changed = true;
  }

  if (changed) {
    applyDarkMode(darkEnabled());
    updateQuickToggleButton();
    prismLastSig = prismSettingsSig();
  }
});

// Popup color picks land while this tab sits in the background. On return,
// re-read and re-apply only if something actually changed â€” the attribute
// write re-triggers the canvas engine, which replays the repaint.
try {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    try {
      chrome.storage.local.get(PRISM_KEYS, (res) => {
        try {
          if (prismResSig(res) === prismLastSig) return;
          snapshotFromStorage(res);
          updateQuickToggleButton();
        } catch (_) {}
      });
    } catch (_) {}
  });
} catch (_) {}

// Which Google surface is this? docs | sheets | slides | preview | docshome
// Slides file-list home counts as docshome (stays dark); only the
// presentation editor itself is 'slides' (stays light).
function detectApp() {
  try {
    const p = window.location.pathname;
    const h = window.location.hostname;
    if (p.includes('/_/og/') || p.includes('/auth_warmup') || p.includes('/drivesharing/') || p.includes('/picker') || p.includes('/notifications/')) {
      return 'utility';
    }
    if (p.includes('/spreadsheets/')) return 'sheets';
    if (p.includes('/presentation/') && (p.includes('/d/') || p.includes('/edit'))) return 'slides';
    if (p.includes('/presentation/')) return 'docshome';
    if (p.includes('/file/') || p.includes('/preview') || p.includes('/viewer') || p.includes('/viewerng/') || h.includes('usercontent.google.com')) return 'preview';
    if (p.includes('/document/') && (p.includes('/d/') || p.includes('/edit') || p.includes('/create'))) return 'docs';
    try {
      if (h.includes('drive.google.com')) return 'drive';
    } catch (_) {}
    return 'docshome';
  } catch (_) { return 'docs'; }
}

function applyDarkMode(enable) {
  const html = document.documentElement;
  const app = detectApp();
  // Docs/Sheets editors get our hand theme + canvas engine (the document).
  // Drive + homepages get Edge-model inversion. Slides editor + PDF/file
  // preview stay light (removed surfaces) â€” not even inversion.
  const isEditor = app === 'docs' || app === 'sheets';
  html.removeAttribute('data-prism-dark');
  html.removeAttribute('data-prism-shell');
  if (enable) {
    html.setAttribute('data-prism-app', app);
    if (app === 'slides' || app === 'preview') return;
    if (!isEditor) {
      html.setAttribute('data-prism-shell', 'edge');
      return;
    }
    html.setAttribute('data-prism-dark', 'true');
    html.setAttribute('data-prism-variant', darkVariant);
    html.setAttribute('data-prism-dark-color', darkColor);
    html.setAttribute('data-prism-doc-color', docColor);
    html.setAttribute('data-prism-text-color', textColorSetting);
    html.setAttribute('data-prism-border', showBorder ? 'on' : 'off');
    html.setAttribute('data-prism-instant', instantRepaint ? 'true' : 'false');
    // Theme color drives the outer page AND the chrome (headers, side panels).
    // Skipped until the user picks one so Normal/Midnight defaults keep working.
    html.style.setProperty('--prism-bg', darkColor);
    if (hasCustomBg) {
      html.style.setProperty('--prism-root', darkColor);
      // Keep controls chromatic with the selected theme instead of falling
      // back to the fixed midnight blacks from docs-dark.css.
      html.style.setProperty('--prism-surface', shadeColor(darkColor, -28));
      html.style.setProperty('--prism-surface-high', shadeColor(darkColor, -12));
      html.style.setProperty('--prism-surface-3', shadeColor(darkColor, 8));
      html.style.setProperty('--prism-surface-4', shadeColor(darkColor, 24));
      html.style.setProperty('--prism-border', shadeColor(darkColor, 34));
      html.style.setProperty('--prism-border-strong', shadeColor(darkColor, 48));
    } else {
      html.style.removeProperty('--prism-root');
      html.style.removeProperty('--prism-surface');
      html.style.removeProperty('--prism-surface-high');
      html.style.removeProperty('--prism-surface-3');
      html.style.removeProperty('--prism-surface-4');
      html.style.removeProperty('--prism-border');
      html.style.removeProperty('--prism-border-strong');
    }
    const bodyColor = shadeColor(darkColor, -14);
    html.style.setProperty('--prism-body', bodyColor);
    // â€¦document editor sheet from the separate Document setting
    html.style.setProperty('--prism-doc', docColor);
    html.style.setProperty('--prism-accent-hue', String(accentHue));
  } else {
    html.removeAttribute('data-prism-app');
    html.removeAttribute('data-prism-variant');
    html.removeAttribute('data-prism-dark-color');
    html.removeAttribute('data-prism-doc-color');
    html.removeAttribute('data-prism-text-color');
    html.removeAttribute('data-prism-border');
    html.removeAttribute('data-prism-instant');
    html.style.removeProperty('--prism-bg');
    html.style.removeProperty('--prism-root');
    html.style.removeProperty('--prism-body');
    html.style.removeProperty('--prism-doc');
    html.style.removeProperty('--prism-accent-hue');
    html.style.removeProperty('--prism-surface');
    html.style.removeProperty('--prism-surface-high');
    html.style.removeProperty('--prism-surface-3');
    html.style.removeProperty('--prism-surface-4');
    html.style.removeProperty('--prism-border');
    html.style.removeProperty('--prism-border-strong');
  }
  window.dispatchEvent(new CustomEvent('prism-dark-toggle', {
    detail: { enabled: enable, darkColor, docColor, textColor: textColorSetting, app: detectApp() }
  }));
  // Docs and Sheets redraw their canvas when the app-switcher control is
  // activated. Reuse that native redraw path after a manual theme change.
  if (app === 'docs' || app === 'sheets') triggerNativeCanvasRedraw();
}

let nativeCanvasRedrawTimer = 0;
function triggerNativeCanvasRedraw() {
  try {
    // Color inputs emit many updates while dragging. Keep only the trailing
    // request so the side panel is toggled once for the final color.
    clearTimeout(nativeCanvasRedrawTimer);
    nativeCanvasRedrawTimer = setTimeout(() => {
      try {
        const companion = document.querySelector('.app-switcher-button.companion-collapser-button[role="button"] .app-switcher-button-icon-container');
        const icons = companion ? [companion] : [];
        console.log('[Prism] native canvas redraw targets:', icons.length,
          icons.map((icon) => icon.closest('.app-switcher-button')?.className || icon.parentElement?.className));
        icons.forEach((icon, index) => {
          try {
            const target = icon.closest('[role="button"], button') || icon;
            ['mousedown', 'mouseup', 'click'].forEach((type) => {
              target.dispatchEvent(new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window,
                buttons: type === 'mouseup' ? 0 : 1
              }));
            });
            console.log('[Prism] native redraw click', index + 1, target.tagName, target.className);
          } catch (error) {
            console.warn('[Prism] native redraw click failed', error);
          }
        });
      } catch (_) {}
    }, 180);
  } catch (_) {}
}

// Simple hex shade helper
function shadeColor(hex, amount) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const num = parseInt(hex, 16);
  const r = Math.max(0, Math.min(255, ((num >> 16) & 255) + amount));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (num & 255) + amount));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// â”€â”€ Quick Toggle Floating Button â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function injectQuickToggleButton() {
  if (window !== window.top) return;
  // All Docs/Sheets/Drive tabs (not just documents) â€” visibility is gated
  // by the popup's Quick Toggle switch.
  if (document.getElementById('prism-dark-quick-toggle')) return;

  const btn = document.createElement('button');
  btn.id = 'prism-dark-quick-toggle';
  btn.setAttribute('aria-label', 'Toggle Dark Mode');
  btn.title = 'Prism Dark Mode';
  btn.type = 'button';
  btn.dataset.prismHidden = String(!showQuickToggle);
  updateQuickToggleButtonIcon(btn, darkEnabled());

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    isDocsDarkMode = !isDocsDarkMode;
    applyDarkMode(darkEnabled());
    updateQuickToggleButtonIcon(btn, darkEnabled());
    try {
      chrome.storage.local.set({ docsDarkMode: isDocsDarkMode });
    } catch (_) {}
  });

  const mount = () => {
    if (!document.getElementById('prism-dark-quick-toggle') && document.body) {
      document.body.appendChild(btn);
    }
  };

  if (document.body) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  }
}

function updateQuickToggleButton() {
  const btn = document.getElementById('prism-dark-quick-toggle');
  if (btn) {
    btn.dataset.prismHidden = String(!showQuickToggle);
    updateQuickToggleButtonIcon(btn, darkEnabled());
  } else if (showQuickToggle) {
    // Button was never injected (e.g. toggled on from the popup later).
    injectQuickToggleButton();
  }
}

function updateQuickToggleButtonIcon(btn, isDark) {
  if (isDark) {
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5"></circle>
        <line x1="12" y1="1" x2="12" y2="3"></line>
        <line x1="12" y1="21" x2="12" y2="23"></line>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
        <line x1="1" y1="12" x2="3" y2="12"></line>
        <line x1="21" y1="12" x2="23" y2="12"></line>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
      </svg>`;
    btn.title = 'Prism: Switch to Light Mode';
  } else {
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.9 8.9 0 1 0 20.5 14.2z"></path>
      </svg>`;
    btn.title = 'Prism: Switch to Dark Mode (Image-Safe)';
  }
}

// â”€â”€ Deep-Link / Native Find & PDF Navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Captured immediately (this file runs at document_start) so we grab
// the fragment before any other script on the page has a chance to touch it.
const initialHash = window.location.hash;

let isSearching = false;

function parseHashParams(hash) {
  if (!hash) return {};
  let clean = hash.replace(/^[#?]/, '');
  const dirIdx = clean.indexOf(':~:');
  if (dirIdx !== -1) clean = clean.slice(0, dirIdx);
  const params = {};
  for (const part of clean.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) {
      params[decodeURIComponent(part)] = '';
    } else {
      const k = decodeURIComponent(part.slice(0, eq));
      const v = decodeURIComponent(part.slice(eq + 1));
      params[k] = v;
    }
  }
  return params;
}

function initDeepLink() {
  window.addEventListener('hashchange', handleHashChange);
  processHash(initialHash || window.location.hash);
}

function handleHashChange() {
  processHash(window.location.hash);
}

function processHash(hash) {
  if (!hash || isSearching) return;
  const params = parseHashParams(hash);
  let targetText = params['find-text'] || '';
  if (!targetText && hash.includes('find-text=')) {
    const m = hash.match(/find-text=([^&]+)/i);
    if (m) targetText = decodeURIComponent(m[1]);
  }
  const keyword = params['kw'] || '';
  if (targetText && !isSearching) {
    console.log(`Deep link detected. Searching for snippet: "${targetText}" kw: "${keyword}"`);
    startScrollingSearch(targetText, keyword);
  }
}

async function startScrollingSearch(targetText, keyword) {
  isSearching = true;

  const wasBackgrounded = document.visibilityState !== 'visible';
  await waitForVisible();
  if (wasBackgrounded) {
    await sleep(600);
  }

  window.focus();

  const editorLoaded = await waitForEditorLoad();
  if (!editorLoaded) {
    console.warn('Google Docs editor failed to load or took too long.');
    isSearching = false;
    return;
  }

  console.log('Editor loaded. Searching for text in Google Docs...');
  try {
    document.querySelectorAll('.prism-real-highlighter').forEach(s => s.remove());
  } catch (_) {}

  const candidates = buildSearchCandidates(targetText, keyword);
  console.log('[Prism:doc] Focused search terms:', candidates);

  // Strategy 1: Browser Native Find (0ms, silent)
  for (const c of candidates) {
    const winMatch = findDocsViaWindowFind(c);
    if (winMatch) {
      console.log('[Prism:doc] Found via window.find:', c);
      highlightDocsMatchedElement(winMatch.rects);
      setTimeout(() => {
        const freshRects = (winMatch.range) ? Array.from(winMatch.range.getClientRects()).filter(cr => cr.width > 1 && cr.height > 1) : null;
        highlightDocsMatchedElement(freshRects && freshRects.length > 0 ? freshRects : winMatch.rects);
      }, 120);
      history.replaceState(null, '', window.location.pathname + window.location.search);
      isSearching = false;
      return;
    }
  }

  // Strategy 2: Multi-Frame & Whitespace-Normalized DOM scan (0ms, silent)
  for (const c of candidates) {
    const domMatch = findDocsDomMatch(c);
    if (domMatch) {
      console.log('[Prism:doc] Found via direct DOM scan:', c);
      if (domMatch.element && typeof domMatch.element.scrollIntoView === 'function') {
        domMatch.element.scrollIntoView({ behavior: 'instant', block: 'center' });
      }
      highlightDocsMatchedElement(domMatch.rects);
      setTimeout(() => highlightDocsMatchedElement(domMatch.rects), 120);
      history.replaceState(null, '', window.location.pathname + window.location.search);
      isSearching = false;
      return;
    }
  }

  // Strategy 3: Google Docs Native Quick Find (Ctrl+F)
  const foundIt = await triggerNativeFind(targetText, keyword, candidates);
  if (foundIt) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  isSearching = false;
}

function findDocsViaWindowFind(candidate) {
  if (!candidate || candidate.trim().length < 2) return null;
  const term = candidate.trim();

  // Gather top window and all accessible child iframes
  const allWins = [window];
  try {
    document.querySelectorAll('iframe').forEach(f => {
      try {
        if (f.contentWindow && f.contentWindow.document) {
          allWins.push(f.contentWindow);
        }
      } catch (_) {}
    });
  } catch (_) {}

  for (const win of allWins) {
    try {
      if (typeof win.find !== 'function') continue;
      // win.find(aString, aCaseSensitive, aBackwards, aWrapAround, aWholeWord, aSearchInFrames, aShowDialog)
      const found = win.find(term, false, false, true, false, true, false);
      if (found) {
        const sel = win.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          const startNode = range.startContainer;
          const el = (startNode && startNode.nodeType === 1) ? startNode : (startNode ? startNode.parentElement : null);
          if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
          }

          let rects = Array.from(range.getClientRects()).filter(cr => cr.width > 1 && cr.height > 1);
          if (rects.length === 0 && el) {
            const er = el.getBoundingClientRect();
            if (er.width > 1 && er.height > 1) rects = [er];
          }

          // If inside iframe, offset rects by iframe coordinates
          if (win !== window && win.frameElement) {
            const fRect = win.frameElement.getBoundingClientRect();
            rects = rects.map(r => ({
              left: r.left + fRect.left,
              right: r.right + fRect.left,
              top: r.top + fRect.top,
              bottom: r.bottom + fRect.top,
              width: r.width,
              height: r.height,
              element: el
            }));
          }

          if (rects.length > 0) {
            return { element: el, range, rects, candidate: term };
          }
        }
      }
    } catch (_) {}
  }
  return null;
}

function findDocsDomMatch(candidate) {
  if (!candidate || candidate.trim().length < 2) return null;
  const term = candidate.trim();
  const termNorm = term.replace(/[\u00a0\u2000-\u200b\s]+/g, ' ').toLowerCase();

  const allDocs = [document];
  try {
    document.querySelectorAll('iframe').forEach(f => {
      try {
        if (f.contentDocument && f.contentDocument.body) {
          allDocs.push(f.contentDocument);
        }
      } catch (_) {}
    });
  } catch (_) {}

  for (const doc of allDocs) {
    try {
      // 1. TextNode TreeWalker with whitespace & NBSP normalization
      const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue) continue;
        const valNorm = node.nodeValue.replace(/[\u00a0\u2000-\u200b\s]+/g, ' ').toLowerCase();
        const idx = valNorm.indexOf(termNorm);
        if (idx !== -1) {
          const parent = node.parentElement;
          if (parent && parent.closest && parent.closest('.ds-side-pane, #ds-side-pane, .ds-search-box, [id^="prism"]')) {
            continue;
          }
          if (parent && typeof parent.scrollIntoView === 'function') {
            parent.scrollIntoView({ behavior: 'instant', block: 'center' });
          }
          const r = doc.createRange();
          try {
            r.setStart(node, Math.min(node.nodeValue.length, idx));
            r.setEnd(node, Math.min(node.nodeValue.length, idx + term.length));
          } catch (_) {
            r.selectNodeContents(parent || node);
          }
          let rects = Array.from(r.getClientRects()).filter(cr => cr.width > 1 && cr.height > 1);
          if (rects.length === 0 && parent) {
            const pr = parent.getBoundingClientRect();
            if (pr.width > 1 && pr.height > 1) rects = [pr];
          }
          if (rects.length > 0) {
            return { element: parent, range: r, rects };
          }
        }
      }

      // 2. Line/paragraph container check (when text is split across multiple spans)
      const containers = doc.querySelectorAll('.kix-lineview, .kix-paragraphrenderer, .kix-page-content-wrapper, [role="paragraph"], p, div');
      for (const cont of containers) {
        if (cont.closest && cont.closest('.ds-side-pane, #ds-side-pane, .ds-search-box, [id^="prism"]')) continue;
        const cText = (cont.textContent || '').replace(/[\u00a0\u2000-\u200b\s]+/g, ' ').toLowerCase();
        if (cText.includes(termNorm)) {
          if (typeof cont.scrollIntoView === 'function') {
            cont.scrollIntoView({ behavior: 'instant', block: 'center' });
          }
          const cr = cont.getBoundingClientRect();
          if (cr.width > 10 && cr.height > 5) {
            return { element: cont, rects: [cr] };
          }
        }
      }
    } catch (_) {}
  }

  return null;
}

function waitForVisible() {
  return new Promise((resolve) => {
    if (document.visibilityState === 'visible') { resolve(); return; }
    console.log('[nativeFind] Tab not immediately visible, waiting for focus.');

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(safetyTimer);
      resolve();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') finish(); };
    document.addEventListener('visibilitychange', onVisible);
    const safetyTimer = setTimeout(() => { finish(); }, 2000);
  });
}

async function triggerNativeFind(targetText, keyword, candidateList) {
  console.log('[nativeFind] target:', targetText, 'kw:', keyword);

  let inputReady = !!getFindInput();

  // 1. Try silent shortcut (Ctrl+F / Cmd+F) without clicking any menus
  if (!inputReady) {
    dispatchFindShortcut();
    inputReady = await waitForFindInput(6);
  }

  // NO EDIT MENU FALLBACK: Under no circumstances click Edit menu or open dropdowns
  if (!inputReady) {
    console.log('[nativeFind] Find input not open, skipping dialog search.');
    return false;
  }

  console.log('[nativeFind] Find dialog ready.');

  const candidates = candidateList || buildSearchCandidates(targetText, keyword);
  for (const candidate of candidates) {
    console.log(`[nativeFind] trying candidate: "${candidate}"`);
    const matched = await runFindQuery(candidate);
    console.log(`[nativeFind] candidate ${matched ? 'MATCHED' : 'no match'}`);
    if (matched) {
      await sleep(200);
      const capturedRects = captureDocsMatchRects(candidate);

      // Keep the native find dialog open with the whole line so Google Docs' native highlight and match remain active!
      // Apply whole-line highlighter strip
      const finalRects = (capturedRects && capturedRects.length > 0) ? capturedRects : captureDocsMatchRects(candidate);
      if (finalRects && finalRects.length > 0) {
        highlightDocsMatchedElement(finalRects);
        setTimeout(() => highlightDocsMatchedElement(finalRects), 120);
      }

      return true;
    }
  }

  // Keep dialog open with the searched query rather than closing it
  return false;
}

// ── Google Docs Whole-Line Highlighter ───────────────────────────────────────
function captureDocsMatchRects(candidate) {
  const rects = [];

  // Method 1: Google Docs selection overlays (.kix-selection-overlay)
  try {
    const overlays = Array.from(document.querySelectorAll('.kix-selection-overlay, [class*="selection-overlay"], [class*="selectionOverlay"]'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2 && r.top >= -50 && r.bottom <= window.innerHeight + 100;
      });
    if (overlays.length > 0) {
      overlays.forEach(el => {
        const r = el.getBoundingClientRect();
        rects.push({
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
          element: el
        });
      });
      console.log('[Prism:doc] Found match rects via .kix-selection-overlay:', rects.length);
      return rects;
    }
  } catch (_) {}

  // Method 2: DOM text TreeWalker / createRangeForText
  try {
    const term = (candidate || '').trim();
    if (term) {
      const editor = document.querySelector('.kix-appview-editor') || document.body;
      const domMatch = findDocsDomMatch(term);
      if (domMatch && domMatch.rects && domMatch.rects.length > 0) {
        domMatch.rects.forEach(cr => {
          rects.push({
            left: cr.left,
            right: cr.right,
            top: cr.top,
            bottom: cr.bottom,
            width: cr.width,
            height: cr.height,
            element: domMatch.element
          });
        });
        console.log('[Prism:doc] Found match rects via findDocsDomMatch');
        return rects;
      }
    }
  } catch (_) {}

  // Method 3: window.getSelection()
  try {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      const clientRects = Array.from(r.getClientRects()).filter(cr => cr.width > 2 && cr.height > 2);
      if (clientRects.length > 0) {
        clientRects.forEach(cr => {
          rects.push({
            left: cr.left,
            right: cr.right,
            top: cr.top,
            bottom: cr.bottom,
            width: cr.width,
            height: cr.height,
            element: r.startContainer
          });
        });
        console.log('[Prism:doc] Found match rects via window.getSelection()');
        return rects;
      }
    }
  } catch (_) {}

  return rects;
}

function groupDocsRectsByLine(rects) {
  const lineBoxes = [];
  for (const r of rects) {
    if (r.width <= 2 || r.height <= 2) continue;
    let box = lineBoxes.find(b => Math.abs(b.top - r.top) < 8);
    if (!box) {
      box = {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        height: r.height,
        element: r.element
      };
      lineBoxes.push(box);
    } else {
      box.left = Math.min(box.left, r.left);
      box.right = Math.max(box.right, r.right);
      box.top = Math.min(box.top, r.top);
      box.bottom = Math.max(box.bottom, r.bottom);
      box.height = Math.max(box.height, r.height);
      if (!box.element && r.element) box.element = r.element;
    }
  }
  return lineBoxes;
}

function highlightDocsMatchedElement(matchRects) {
  if (!matchRects || matchRects.length === 0) return;

  // Remove existing highlighter strips first
  document.querySelectorAll('.prism-real-highlighter').forEach(s => s.remove());

  const isDark = document.documentElement.getAttribute('data-prism-dark') === 'true';
  const blendMode = isDark ? 'screen' : 'multiply';
  const bgColor = isDark ? 'rgba(255, 215, 0, 0.35)' : 'rgba(255, 235, 59, 0.65)';
  const shadowColor = isDark ? 'rgba(255, 215, 0, 0.5)' : 'rgba(255, 235, 59, 0.85)';

  const lineBoxes = groupDocsRectsByLine(matchRects);

  for (const box of lineBoxes) {
    // Find page container for this line box
    let page = null;
    if (box.element && typeof box.element.closest === 'function') {
      page = box.element.closest('.kix-page, .kix-page-paginated, .kix-page-canvas-compact-mode');
    }
    if (!page) {
      const centerX = Math.max(10, Math.min(window.innerWidth - 10, box.left + ((box.right - box.left) / 2)));
      const centerY = Math.max(10, Math.min(window.innerHeight - 10, box.top + (box.height / 2)));
      const elementsAtPoint = document.elementsFromPoint(centerX, centerY);
      page = elementsAtPoint.find(el => el.classList && (
        el.classList.contains('kix-page') ||
        el.classList.contains('kix-page-paginated') ||
        el.classList.contains('kix-page-canvas-compact-mode')
      ));
    }
    if (!page) {
      page = document.querySelector('.kix-page-paginated')
          || document.querySelector('.kix-page')
          || document.querySelector('.kix-appview-editor')
          || document.body;
    }

    const isPageContainer = page && page !== document.body && page !== document.documentElement;
    if (isPageContainer) {
      const compPos = window.getComputedStyle(page).position;
      if (compPos === 'static') {
        page.style.position = 'relative';
      }
    }
    const container = isPageContainer ? page : (document.body || document.documentElement);

    let pRect = { left: 0, top: 0, width: window.innerWidth, right: window.innerWidth };
    let offsetX = 0;
    let offsetY = 0;
    if (isPageContainer) {
      pRect = page.getBoundingClientRect();
      const pBorderLeft = page.clientLeft || 0;
      const pBorderTop = page.clientTop || 0;
      offsetX = -pRect.left - pBorderLeft;
      offsetY = -pRect.top - pBorderTop;
    } else {
      offsetX = window.pageXOffset || document.documentElement.scrollLeft || 0;
      offsetY = window.pageYOffset || document.documentElement.scrollTop || 0;
    }

    // Expand across the text column of the Google Docs page
    const textMarginLeft = Math.max(pRect.left + 45, Math.min(box.left - 15, pRect.left + 90));
    const textMarginRight = Math.min(pRect.right - 45, Math.max(box.right + 15, pRect.right - 90));

    const lineLeft = Math.min(box.left - 6, textMarginLeft);
    const lineRight = Math.max(box.right + 6, textMarginRight);

    const padY = 3;
    const sLeft = Math.round(lineLeft + offsetX);
    const sTop = Math.round(box.top + offsetY - padY);
    const sWidth = Math.round(Math.max(lineRight - lineLeft, 100));
    const sHeight = Math.round(Math.max(box.height + (padY * 2), 16));

    const strip = document.createElement('div');
    strip.className = 'prism-real-highlighter prism-docs-highlighter';
    strip.style.cssText = `
      position: absolute;
      left: ${sLeft}px;
      top: ${sTop}px;
      width: ${sWidth}px;
      height: ${sHeight}px;
      background-color: ${bgColor};
      border-radius: 3px;
      pointer-events: none;
      z-index: 2147483640;
      mix-blend-mode: ${blendMode};
      box-shadow: 0 0 8px ${shadowColor};
      transition: opacity 1.2s ease;
    `;
    container.appendChild(strip);

    // Fade out gently after 9 seconds
    setTimeout(() => {
      try {
        strip.style.opacity = '0';
        setTimeout(() => { try { strip.remove(); } catch(_) {} }, 1200);
      } catch (_) {}
    }, 9000);
  }

  console.log('[Prism:doc] Whole-line highlighter strips applied to Google Docs:', lineBoxes.length);
}

function dispatchFindShortcut() {
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const eventInit = {
    key: 'f',
    code: 'KeyF',
    keyCode: 70,
    which: 70,
    shiftKey: false,
    metaKey: isMac,
    ctrlKey: !isMac,
    bubbles: true,
    cancelable: true,
    view: window
  };
  // Focus the canvas/page first so Google Docs editor input layer is focused
  const canvas = document.querySelector('.kix-canvas-tile-content') || document.querySelector('.kix-page') || document.querySelector('.kix-appview-editor');
  if (canvas) clickElement(canvas);

  const targets = [
    document.activeElement,
    document.querySelector('iframe.docs-textelement-iframe')?.contentDocument?.body,
    document.querySelector('iframe.docs-textelement-iframe')?.contentDocument,
    document.querySelector('iframe.docs-textelement-iframe')?.contentWindow,
    document.querySelector('.docs-textelement'),
    document.querySelector('.kix-appview-editor'),
    document.body,
    document,
    window
  ].filter(Boolean);

  for (const t of targets) {
    try {
      t.dispatchEvent(new KeyboardEvent('keydown', eventInit));
      t.dispatchEvent(new KeyboardEvent('keypress', eventInit));
      t.dispatchEvent(new KeyboardEvent('keyup', eventInit));
    } catch (_) {}
  }
}

function clickElement(el) {
  ['mousedown', 'mouseup', 'click'].forEach((type) => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  });
}

function waitForFindInput(maxAttempts = 30) {
  return new Promise((resolve) => {
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const input = getFindInput();
      if (input && input.offsetParent !== null) { clearInterval(interval); resolve(true); }
      else if (attempts >= maxAttempts) { clearInterval(interval); resolve(false); }
    }, 80);
  });
}

function getFindInput() {
  // 1. Any input inside an open dialog (Find and replace modal)
  const dialogs = document.querySelectorAll('[role="dialog"], .docs-dialog, .modal-dialog, div[class*="dialog"]');
  for (const dialog of dialogs) {
    if (dialog.offsetParent !== null) {
      const inputs = dialog.querySelectorAll('input[type="text"], input:not([type]), input[type="search"]');
      for (const inp of inputs) {
        if (inp.offsetParent !== null && !inp.disabled && !inp.readOnly) {
          return inp;
        }
      }
    }
  }

  // 2. Quick find bubble (.docs-findbubble)
  const bubble = document.querySelector('.docs-findbubble, #docs-findbubble, [class*="findbubble"]');
  if (bubble && bubble.offsetParent !== null) {
    const inp = bubble.querySelector('input');
    if (inp && inp.offsetParent !== null) return inp;
  }

  // 3. Known specific selectors
  const selectors = [
    'input[aria-label*="Find" i]',
    'input[aria-label*="Search" i]:not([aria-label*="Drive" i]):not([aria-label*="Google" i])',
    'input[placeholder*="Find" i]',
    'input[placeholder*="Search in document" i]',
    '.docs-findandreplace-dialog input',
    'input[class*="WizTextFieldOutlined-text-field__input"]'
  ];
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null && !el.closest('.ds-side-pane, #ds-side-pane, .ds-search-box')) return el;
    } catch (_) {}
  }
  return null;
}

function closeFindDialog() {
  const closeBtn = document.querySelector('[aria-label="Close"], [aria-label*="Close" i], .docs-dialog-close, [class*="close-button"]');
  if (closeBtn) clickElement(closeBtn);
  try {
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  } catch (_) {}
}

function buildSearchCandidates(targetText, keyword) {
  const clean = (targetText || '')
    .replace(/^[\.\s\u2026]+/, '')
    .replace(/[\.\s\u2026]+$/, '')
    .replace(/^["'“”‘’«»]+/, '')
    .replace(/["'“”‘’«»]+$/, '')
    .replace(/[\u00a0\u2000-\u200b\s]+/g, ' ')
    .trim();

  // User strictly requested whole line search only:
  // When whole line is present, search ONLY with the whole line.
  // Never switch or fall back to keyword ("welcome").
  if (clean && clean.length >= 2) {
    return [clean];
  }

  const kw = (keyword || '')
    .replace(/^["'“”‘’«»]+/, '')
    .replace(/["'“”‘’«»]+$/, '')
    .replace(/[,\.:;!?]+$/, '')
    .trim();

  if (kw && kw.length >= 2) {
    return [kw];
  }

  return [];
}

function getFindBarContainer() {
  const input = getFindInput();
  if (!input) return null;
  const dialog = input.closest('[role="dialog"], .docs-dialog, .modal-dialog, .docs-findbubble, [class*="dialog"], [class*="findbubble"]');
  if (dialog) return dialog;
  let el = input;
  while (el && el !== document.body) {
    if (el.textContent && (el.textContent.includes('Find and replace') || el.textContent.includes('of') || el.textContent.includes('/'))) return el;
    el = el.parentElement;
  }
  return input.parentElement;
}

function runFindQuery(text) {
  return new Promise((resolve) => {
    const input = getFindInput();
    if (!input) { resolve(false); return; }

    const win = window;
    input.focus();
    input.select();

    const dispatchEnter = () => {
      ['keydown', 'keypress', 'keyup'].forEach(type => {
        input.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13,
          bubbles: true, cancelable: true, view: win
        }));
      });
    };

    const nativeSetter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Immediately press Enter so Google Docs navigates to and highlights the whole line!
    dispatchEnter();

    // Poll for match confirmation up to 3000ms (handling slower networks/rendering)
    const startTime = Date.now();
    const MAX_WAIT = 3000;
    const POLL_INTERVAL = 80;
    let enterDispatches = 1;

    const poll = () => {
      const container = getFindBarContainer();
      let containerText = '';
      if (container) {
        containerText = container.textContent || '';
        const ariaEls = container.querySelectorAll('[aria-label], [aria-live], .docs-findbubble-match-count');
        ariaEls.forEach(el => {
          containerText += ' ' + (el.getAttribute('aria-label') || el.textContent || '');
        });
      }

      // Check if Google Docs rendered selection overlay on the canvas
      const overlays = document.querySelectorAll('.kix-selection-overlay, [class*="selection-overlay"], [class*="selectionOverlay"]');
      const hasOverlays = overlays.length > 0;

      // Positive match patterns: "1 of 1", "1/1", "1 of 4", etc.
      const hasPositiveCount = /\b[1-9]\d*\s*(?:of|\/)\s*\d+\b/i.test(containerText);
      const isZeroCount = /\b0\s*(?:of|\/)\s*0\b/i.test(containerText);
      const noResults = /no results|no matches/i.test(containerText) || isZeroCount;

      if (hasPositiveCount || hasOverlays) {
        console.log('[runFindQuery] Match confirmed in Google Docs:', { hasPositiveCount, hasOverlays });
        dispatchEnter();
        resolve(true);
        return;
      }

      const elapsed = Date.now() - startTime;

      // Only reject if Google Docs explicitly says "0 of 0" or "no results" AFTER giving it at least 800ms
      if (noResults && elapsed >= 800) {
        console.log('[runFindQuery] Google Docs reported no results.');
        resolve(false);
        return;
      }

      // Periodically re-dispatch Enter to trigger Google Docs search listener if needed
      if (elapsed > 400 * enterDispatches && enterDispatches <= 3) {
        enterDispatches++;
        dispatchEnter();
      }

      if (elapsed >= MAX_WAIT) {
        // If Docs didn't explicitly say "0 of 0", assume match so we keep the whole line in the box
        if (!noResults) {
          console.log('[runFindQuery] Reached timeout without negative confirmation, keeping search active');
          resolve(true);
        } else {
          resolve(false);
        }
        return;
      }

      setTimeout(poll, POLL_INTERVAL);
    };

    setTimeout(poll, 80);
  });
}

function waitForEditorLoad() {
  return new Promise((resolve) => {
    let checkCount = 0;
    const interval = setInterval(() => {
      const editor = document.querySelector('.kix-appview-editor');
      const canvas = document.querySelector('.kix-canvas-tile-content, canvas.kix-canvas-tile-content');
      const page = document.querySelector('.kix-page, .kix-page-paginated, .kix-page-content-wrapper');
      const textIframe = document.querySelector('iframe.docs-textelement-iframe, .docs-textelement');
      const ready = editor && (canvas || page || textIframe);
      checkCount++;
      if (ready) {
        clearInterval(interval);
        setTimeout(() => resolve(true), 600);
        return;
      }
      if (checkCount > 150) {
        clearInterval(interval);
        resolve(!!editor);
      }
    }, 100);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Shows a premium modern toast notification inside Google Docs / Drive.
 */
function showNotification(message) {
  try {
    if (window !== window.top) {
      window.top.postMessage({ type: 'PRISM_TOAST', message }, '*');
    }
  } catch (_) {}

  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => showNotification(message), { once: true });
    return;
  }

  const existing = document.getElementById('prism-doc-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'prism-doc-toast';
  toast.style.cssText = `
    position: fixed;
    bottom: 30px;
    left: 50%;
    transform: translateX(-50%) translateY(20px);
    background: rgba(26, 27, 30, 0.95);
    color: #f1f5f9;
    padding: 12px 24px;
    border-radius: 12px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Outfit', sans-serif;
    font-size: 0.9rem;
    font-weight: 500;
    line-height: 1.45;
    max-width: 480px;
    text-align: center;
    z-index: 2147483647;
    box-shadow: 0 12px 36px rgba(0,0,0,0.35);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.15);
    opacity: 0;
    pointer-events: none;
    transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
  `;
  toast.innerText = message;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.transform = 'translateX(-50%) translateY(0)';
    toast.style.opacity = '1';
  }, 50);
  
  const displayMs = Math.min(12000, Math.max(4500, message.length * 60));
  setTimeout(() => {
    if (toast.parentElement) {
      toast.style.transform = 'translateX(-50%) translateY(20px)';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 400);
    }
  }, displayMs);
}

// ── Google Drive PDF Deep Link & Paragraph Navigation ────────────────────────
let isPdfJumping = false;
let activePendingJump = null;

function waitForBody() {
  if (document.body) return Promise.resolve();
  return new Promise(resolve => {
    const check = () => {
      if (document.body) resolve();
      else setTimeout(check, 50);
    };
    check();
  });
}

function broadcastPdfJump(targetText, keyword, pageNum) {
  const msg = { type: 'PRISM_PDF_JUMP', targetText, keyword, pageNum };
  try {
    document.querySelectorAll('iframe').forEach(iframe => {
      try {
        const src = (iframe.src || '').toLowerCase();
        if (src.includes('/_/og/') || src.includes('/auth_warmup') || src.includes('/drivesharing/') || src.includes('/picker') || src.includes('/notifications/')) return;
        iframe.contentWindow?.postMessage(msg, '*');
      } catch (_) {}
    });
  } catch (_) {}
}

function initPdfDeepLink() {
  console.log('[Prism:pdf] initPdfDeepLink called, URL:', window.location.href.slice(0, 80), 'isTop:', window === window.top);

  // Listen for cross-frame messages (broadcast from top frame or child iframe)
  window.addEventListener('message', (e) => {
    try {
      if (e.data?.type === 'PRISM_PDF_JUMP') {
        console.log('[Prism:pdf] Received PRISM_PDF_JUMP in frame:', window.location.href.slice(0, 80));
        const { targetText, keyword, pageNum } = e.data;
        if (targetText || keyword || pageNum) {
          handlePdfJump(targetText || '', keyword || '', pageNum || 1);
        }
      }
      if (e.data?.type === 'PRISM_TOAST' && e.data.message) {
        if (window === window.top) {
          showNotification(e.data.message);
        }
      }
    } catch (_) {}
  });

  // Top window monitors for newly inserted viewer iframes and forwards the jump payload
  if (window === window.top) {
    try {
      const observer = new MutationObserver(() => {
        if (!activePendingJump) return;
        document.querySelectorAll('iframe').forEach(iframe => {
          if (!iframe.dataset.prismJumpBound) {
            iframe.dataset.prismJumpBound = '1';
            const src = (iframe.src || '').toLowerCase();
            if (src.includes('/_/og/') || src.includes('/auth_warmup') || src.includes('/drivesharing/') || src.includes('/picker') || src.includes('/notifications/')) return;
            iframe.addEventListener('load', () => {
              console.log('[Prism:pdf] Child iframe loaded, broadcasting jump');
              broadcastPdfJump(activePendingJump.targetText, activePendingJump.keyword, activePendingJump.pageNum);
            });
            try {
              iframe.contentWindow?.postMessage({
                type: 'PRISM_PDF_JUMP',
                targetText: activePendingJump.targetText,
                keyword: activePendingJump.keyword,
                pageNum: activePendingJump.pageNum
              }, '*');
            } catch (_) {}
          }
        });
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
  }

  // Listen for storage changes (catches jump signals set by content-search.js)
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.prismPendingPdfJump?.newValue) {
        const p = changes.prismPendingPdfJump.newValue;
        const age = Date.now() - (p.timestamp || 0);
        if (age < 30000) {
          handlePdfJump(p.targetText || '', p.keyword || '', p.pageNum || 1);
        }
      }
    });
  } catch (_) {}

  // Read pending jump from chrome.storage.local first (reliable across Google Drive redirects)
  try {
    chrome.storage.local.get(['prismPendingPdfJump'], (res) => {
      const pending = res?.prismPendingPdfJump;
      if (pending) {
        const age = Date.now() - (pending.timestamp || 0);
        if (age < 30000 && (pending.keyword || pending.targetText)) {
          console.log('[Prism:pdf] Prioritizing pending jump from storage:', pending);
          handlePdfJump(pending.targetText || '', pending.keyword || '', pending.pageNum || 1);
          return;
        }
      }
      // If storage had no active jump, fallback to URL hash
      checkUrlHashJump();
    });
  } catch (_) {
    checkUrlHashJump();
  }

  function checkUrlHashJump() {
    let hash = window.location.hash || initialHash;
    if (!hash && window !== window.top) {
      try {
        if (window.top && window.top.location.hash) {
          hash = window.top.location.hash;
        }
      } catch (_) {}
    }

    if (hash && (hash.includes('find-text=') || hash.includes('kw=') || hash.includes('page='))) {
      processPdfHash(hash);
    }
  }

  // Also listen for hashchange events
  window.addEventListener('hashchange', () => {
    checkUrlHashJump();
  });
}

function processPdfHash(hash) {
  if (!hash || isPdfJumping) return;
  const params = parseHashParams(hash);
  let targetText = params['find-text'] || '';
  if (!targetText && hash.includes('find-text=')) {
    const m = hash.match(/find-text=([^&]+)/i);
    if (m) targetText = decodeURIComponent(m[1]);
  }
  const keyword = params['kw'] || '';
  const pageNum = parseInt(params['page'] || '1', 10);
  if (!targetText && !keyword && !params['page']) return;
  handlePdfJump(targetText, keyword, pageNum);
}

async function handlePdfJump(targetText, keyword, pageNum) {
  console.log('[Prism:pdf] handlePdfJump called in frame:', window.location.href.slice(0, 70), 'isTop:', window === window.top, { targetText: (targetText||'').slice(0,40), keyword, pageNum, isPdfJumping });
  if (isPdfJumping) return;
  isPdfJumping = true;

  activePendingJump = { targetText, keyword, pageNum, timestamp: Date.now() };

  // Top window broadcasts to child frames
  if (window === window.top) {
    broadcastPdfJump(targetText, keyword, pageNum);
    [400, 1000, 2200, 4500].forEach(delay => {
      setTimeout(() => broadcastPdfJump(targetText, keyword, pageNum), delay);
    });
  }

  await waitForBody();
  await waitForVisible();

  const cleanTerm = (keyword || targetText || '')
    .replace(/^[â€¦\.][â€¦\.\s]*/, '')
    .replace(/[â€¦\.][â€¦\.\s]*$/, '')
    .replace(/^["'â€œâ€˜]+/, '')
    .replace(/["'â€â€™]+$/, '')
    .trim();

  // Copy to clipboard with fallback
  if (cleanTerm) {
    try {
      await navigator.clipboard.writeText(cleanTerm);
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = cleanTerm;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      } catch (_2) {}
    }
  }

  const displaySnippet = cleanTerm.length > 30 ? cleanTerm.slice(0, 30) + 'â€¦' : cleanTerm;
  const pageLabel = pageNum > 1 ? `Page ${pageNum}` : 'PDF';

  // â”€â”€ PHASE 1: Wait for viewer to be truly ready â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let viewerReady = false;
  for (let i = 0; i < 30; i++) {
    const allDocs = getAllViewerDocuments();
    for (const doc of allDocs) {
      if (isViewerReady(doc)) {
        console.log('[Prism:pdf] Phase 1: viewer ready at attempt', i);
        viewerReady = true;
        break;
      }
    }
    if (viewerReady) break;
    await sleep(250);
  }

  // â”€â”€ PHASE 2: Navigate to target page with active polling & verification â”€â”€â”€â”€â”€
  if (pageNum > 1) {
    let pageNavSuccess = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      const allDocs = getAllViewerDocuments();
      let verifiedAtTarget = false;

      for (const doc of allDocs) {
        const pageInput = findPdfPageInput(doc);
        const sc = getPdfScrollContainer(doc);
        const pageEl = findPageContainer(doc, pageNum);

        // Verification criteria:
        // 1. Page input value matches target pageNum AND totalPages is known
        const inputMatches = pageInput && pageInput.value?.trim() === String(pageNum);
        // 2. Scroll container is scrolled significantly down
        const scrolledDown = sc && sc.scrollTop > 200;
        // 3. Target page container is rendered in DOM
        const pageRendered = !!pageEl;

        if (inputMatches || (scrolledDown && (inputMatches || attempt >= 5)) || pageRendered) {
          console.log('[Prism:pdf] Phase 2: Verified page navigation at attempt', attempt, {
            inputVal: pageInput?.value,
            scrollTop: sc?.scrollTop,
            pageRendered
          });
          verifiedAtTarget = true;
          pageNavSuccess = true;
          break;
        }

        // Not verified yet: dispatch navigation
        navigateToPdfPage(doc, pageNum);
      }

      if (verifiedAtTarget) break;
      await sleep(400);
    }
    console.log('[Prism:pdf] Phase 2: navigation final result:', pageNavSuccess);
    // Wait for virtualized page and text layer to render into viewport
    await sleep(900);
  }

  // â”€â”€ PHASE 3: Search for paragraph text & apply real highlight â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  for (let attempt = 0; attempt < 15; attempt++) {
    const allDocs = getAllViewerDocuments();
    const allowGlobal = attempt >= 5;

    for (const doc of allDocs) {
      const match = findPdfParagraphElement(doc, targetText, keyword, pageNum, allowGlobal);
      if (match) {
        const el = match.element || match;
        if (el.closest && el.closest('.ds-side-pane, #ds-side-pane, .ds-search-box, .ds-notification, [id^="prism"]')) {
          continue;
        }
        console.log('[Prism:pdf] Phase 3: Found paragraph, applying real highlight');
        highlightMatchedElement(match);
        showNotification(`Prism: Jumped to match Â· "${cleanTerm || pageLabel}"`);
        clearPendingJump();
        isPdfJumping = false;
        return true;
      }
    }

    await sleep(250);
  }

  showNotification(`Prism: Jumped to ${pageLabel}`);
  clearPendingJump();
  isPdfJumping = false;
  return true;
}

// â”€â”€ Viewer Detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function isViewerReady(doc) {
  if (!doc || !doc.body) return false;
  
  // Total pages detected > 0 (e.g. "1 / 154" or "of 154")
  if (detectTotalPages(doc) > 0) return true;

  // Active canvas rendering
  const canvases = doc.querySelectorAll('canvas');
  for (const c of canvases) {
    if (c.width > 100 || c.offsetWidth > 100) return true;
  }

  // Rendered page containers or regions
  if (doc.querySelector('[data-page-number], .ndfHFb-c4YZDc-DAR3ue, .drive-viewer-page')) {
    return true;
  }

  // Scroll container has substantial scroll height (document rendered)
  const sc = getPdfScrollContainer(doc);
  if (sc && sc.scrollHeight > sc.clientHeight + 400) {
    return true;
  }

  // Embedded PDF
  if (doc.querySelector('embed[type="application/pdf"]')) {
    return true;
  }

  return false;
}

// â”€â”€ Cross-frame Document Collection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getAllViewerDocuments() {
  const docs = [document];
  try {
    for (const iframe of document.querySelectorAll('iframe')) {
      try {
        const src = (iframe.src || '').toLowerCase();
        if (src.includes('/_/og/') || src.includes('/auth_warmup') || src.includes('/drivesharing/') || src.includes('/picker')) continue;
        if (iframe.contentDocument && !docs.includes(iframe.contentDocument)) {
          docs.push(iframe.contentDocument);
          for (const inner of iframe.contentDocument.querySelectorAll('iframe')) {
            try {
              if (inner.contentDocument && !docs.includes(inner.contentDocument)) {
                docs.push(inner.contentDocument);
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  return docs;
}

// â”€â”€ Scroll Container & Page Detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getPdfScrollContainer(doc) {
  if (!doc) return null;
  const selectors = [
    '.ndfHFb-c4YZDc-bveUQe',
    '.drive-viewer-content',
    '.drive-viewer-page-container',
    'c-wiz [tabindex="0"]'
  ];
  for (const sel of selectors) {
    try {
      const el = doc.querySelector(sel);
      if (el && !el.closest('.ds-side-pane, #ds-side-pane, .ds-search-box') && el.scrollHeight > el.clientHeight + 80) return el;
    } catch (_) {}
  }
  try {
    const allDivs = doc.querySelectorAll('div, main, section');
    for (const div of allDivs) {
      if (div.closest('.ds-side-pane, #ds-side-pane, .ds-search-box')) continue;
      if (div.scrollHeight > div.clientHeight + 100 && div.clientHeight > 150) {
        const style = doc.defaultView?.getComputedStyle(div);
        if (style && (style.overflowY === 'auto' || style.overflowY === 'scroll')) {
          return div;
        }
      }
    }
  } catch (_) {}
  const scrolling = doc.scrollingElement || doc.documentElement || doc.body;
  if (scrolling && scrolling.scrollHeight > scrolling.clientHeight + 80) return scrolling;
  return null;
}

function detectTotalPages(doc) {
  if (!doc) return 0;
  try {
    const textEls = doc.querySelectorAll('span, div, p');
    for (const el of textEls) {
      if (el.closest('.ds-side-pane, #ds-side-pane, .ds-search-box')) continue;
      if (el.childElementCount > 0) continue;
      const t = el.textContent?.trim() || '';
      if (t.length > 30) continue;
      const m = t.match(/(?:page\s*)?\b(?:\d+)\s*[/of]\s*(\d+)\b/i);
      if (m) {
        const total = parseInt(m[1], 10);
        if (total > 0 && total < 10000) return total;
      }
    }
  } catch (_) {}
  try {
    const count = doc.querySelectorAll('canvas, .ndfHFb-c4YZDc-DAR3ue, [data-page-number]').length;
    if (count > 1) return count;
  } catch (_) {}
  return 0;
}

function findPageContainer(doc, pageNum) {
  if (!doc || !pageNum) return null;
  const selectors = [
    `[data-page-number="${pageNum}"]`,
    `[data-page="${pageNum}"]`,
    `[id*="page-${pageNum}"]`,
    `[id*="page_${pageNum}"]`,
    `[id*="page${pageNum}"]`,
    `[aria-label*="Page ${pageNum}" i]`,
    `[aria-label*="page ${pageNum}" i]`,
    `.ndfHFb-c4YZDc-DAR3ue:nth-child(${pageNum})`
  ];
  for (const sel of selectors) {
    try {
      const el = doc.querySelector(sel);
      if (el && !el.closest('.ds-side-pane, #ds-side-pane, .ds-search-box')) return el;
    } catch (_) {}
  }
  try {
    const canvases = doc.querySelectorAll('canvas');
    if (canvases.length >= pageNum) {
      const c = canvases[pageNum - 1];
      return c.closest('.ndfHFb-c4YZDc-DAR3ue, .drive-viewer-page, [data-page-number], [role="region"]')
          || c.closest('div[style*="height"], div[style*="width"]')
          || c.parentElement?.parentElement
          || c.parentElement
          || c;
    }
  } catch (_) {}
  try {
    const pages = doc.querySelectorAll('.ndfHFb-c4YZDc-DAR3ue, .drive-viewer-page, [data-page-number], [role="region"]');
    if (pages.length >= pageNum) return pages[pageNum - 1];
  } catch (_) {}
  return null;
}

function findPdfPageInput(doc) {
  if (!doc) return null;
  const inputSelectors = [
    'input[aria-label*="page" i]',
    'input[title*="page" i]',
    'input[placeholder*="page" i]',
    '.ndfHFb-c4YZDc-GSQQnc-LgbsSe input',
    '.drive-viewer-toolstrip-page-number input'
  ];
  for (const sel of inputSelectors) {
    try {
      const el = doc.querySelector(sel);
      if (el && !el.closest('.ds-side-pane, #ds-side-pane, .ds-search-box')) return el;
    } catch (_) {}
  }
  try {
    const allInputs = doc.querySelectorAll('input[type="text"], input:not([type]), input[type="number"]');
    for (const inp of allInputs) {
      if (inp.closest('.ds-side-pane, #ds-side-pane, .ds-search-box')) continue;
      const v = inp.value?.trim();
      const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
      const title = (inp.getAttribute('title') || '').toLowerCase();
      const ph = (inp.getAttribute('placeholder') || '').toLowerCase();
      if (v === '1' || v === '01' || aria.includes('page') || title.includes('page') || ph.includes('page')) {
        return inp;
      }
    }
  } catch (_) {}
  return null;
}

// â”€â”€ Page Navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function navigateToPdfPage(doc, pageNum) {
  if (!doc || !pageNum || pageNum <= 1) return false;
  console.log('[Prism:pdf] navigateToPdfPage called for page', pageNum);
  let actionTaken = false;

  // Strategy 1: Toolbar page input
  const pageInput = findPdfPageInput(doc);
  if (pageInput) {
    try {
      const currentVal = pageInput.value?.trim();
      if (currentVal !== String(pageNum)) {
        console.log('[Prism:pdf] Setting page input value to', pageNum, 'from', currentVal);
        pageInput.focus();
        pageInput.select();
        const win = doc.defaultView || window;
        const nativeSetter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(pageInput, String(pageNum));
        else pageInput.value = String(pageNum);
        pageInput.dispatchEvent(new Event('input', { bubbles: true }));
        pageInput.dispatchEvent(new Event('change', { bubbles: true }));
        ['keydown', 'keypress', 'keyup'].forEach(type => {
          pageInput.dispatchEvent(new KeyboardEvent(type, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13,
            bubbles: true, cancelable: true, composed: true, view: win
          }));
        });
        actionTaken = true;
      }
    } catch (e) {
      console.log('[Prism:pdf] Error interacting with page input:', e);
    }
  }

  // Strategy 2: Direct page container element scroll
  const pageEl = findPageContainer(doc, pageNum);
  if (pageEl) {
    try {
      console.log('[Prism:pdf] Found page container element, scrolling into view');
      pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      actionTaken = true;
    } catch (_) {}
  }

  // Strategy 3: Proportional scroll in scroll container
  const scrollContainer = getPdfScrollContainer(doc);
  if (scrollContainer && scrollContainer.scrollHeight > scrollContainer.clientHeight + 80) {
    try {
      const detected = detectTotalPages(doc);
      const totalPages = Math.max(pageNum, detected > 0 ? detected : pageNum + 10);
      const fraction = Math.min(1, Math.max(0, (pageNum - 1) / totalPages));
      const targetY = Math.round(fraction * (scrollContainer.scrollHeight - scrollContainer.clientHeight));
      if (targetY > 0 && Math.abs(scrollContainer.scrollTop - targetY) > 150) {
        console.log('[Prism:pdf] Scrolling scrollContainer to target Y:', targetY, 'from:', scrollContainer.scrollTop);
        scrollContainer.scrollTop = targetY;
        if (typeof scrollContainer.scrollTo === 'function') {
          scrollContainer.scrollTo({ top: targetY, behavior: 'smooth' });
        }
        scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
        actionTaken = true;
      }
    } catch (e) {
      console.log('[Prism:pdf] Error scrolling scrollContainer:', e);
    }
  }

  return actionTaken;
}

// â”€â”€ Text Paragraph Search & Exact Term Highlighting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function createRangeForText(doc, el, candidate) {
  if (!doc || !el || !candidate) return null;
  try {
    const cLow = candidate.toLowerCase();
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue) continue;
      textNodes.push(node);
      const idx = node.nodeValue.toLowerCase().indexOf(cLow);
      if (idx !== -1) {
        const r = doc.createRange();
        r.setStart(node, idx);
        r.setEnd(node, Math.min(node.nodeValue.length, idx + candidate.length));
        return r;
      }
    }

    // Check if candidate spans across adjacent text nodes (common in PDF text layers)
    if (textNodes.length > 1) {
      const fullText = textNodes.map(n => n.nodeValue).join('');
      const fullIdx = fullText.toLowerCase().indexOf(cLow);
      if (fullIdx !== -1) {
        let charCount = 0;
        let startNode = null, startOffset = 0;
        let endNode = null, endOffset = 0;
        const targetEnd = fullIdx + candidate.length;

        for (const tn of textNodes) {
          const len = tn.nodeValue.length;
          if (!startNode && charCount + len > fullIdx) {
            startNode = tn;
            startOffset = fullIdx - charCount;
          }
          if (charCount + len >= targetEnd) {
            endNode = tn;
            endOffset = targetEnd - charCount;
            break;
          }
          charCount += len;
        }

        if (startNode && endNode) {
          const r = doc.createRange();
          r.setStart(startNode, startOffset);
          r.setEnd(endNode, endOffset);
          return r;
        }
      }
    }

    return null;
  } catch (_) {
    return null;
  }
}

function createRangeForTextWithFallback(doc, el, candidate) {
  const r = createRangeForText(doc, el, candidate);
  if (r) return r;
  try {
    const fallback = doc.createRange();
    fallback.selectNodeContents(el);
    return fallback;
  } catch (_) {
    return null;
  }
}

function findPdfParagraphElement(doc, targetText, keyword, pageNum, allowGlobal = false) {
  if (!doc || !doc.body) return null;

  const isPrismElement = (el) =>
    !!(el && el.closest && el.closest('.ds-side-pane, #ds-side-pane, .ds-search-box, .ds-notification, [id^="prism"]'));

  const cleanKw = (keyword || '')
    .replace(/^["'"']+/, '').replace(/["'"']+$/, '')
    .replace(/[,\.:;!?]+$/, '').trim();

  const cleanSnippet = (targetText || '')
    .replace(/^[â€¦\.][â€¦\.\s]*/, '').replace(/[â€¦\.][â€¦\.\s]*$/, '')
    .replace(/^["'"']+/, '').replace(/["'"']+$/, '')
    .replace(/\s+/g, ' ').trim();

  const termToHighlight = cleanKw || cleanSnippet;
  if (!termToHighlight) return null;

  const termLower = termToHighlight.toLowerCase();
  const win = doc.defaultView || window;
  const targetPageEl = findPageContainer(doc, pageNum || 1);

  console.log('[Prism:pdf] findPdfParagraphElement:', { termToHighlight, pageNum, hasPageEl: !!targetPageEl, allowGlobal });

  // Build context words for scoring (words from snippet that aren't the term itself)
  const contextWords = cleanSnippet.toLowerCase().split(/\s+/)
    .filter(w => w.length >= 3 && !termLower.includes(w));

  // Helper: score an element by how much surrounding text matches snippet context
  const scoreEl = (el, allEls, idx) => {
    const start = Math.max(0, idx - 5);
    const end = Math.min(allEls.length, idx + 6);
    let text = '';
    for (let i = start; i < end; i++) text += ' ' + allEls[i].textContent.toLowerCase();
    return contextWords.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
  };

  // â”€â”€ Strategy 1: Direct DOM scan on target page (no side-effects, most reliable) â”€â”€
  const scopeEl = targetPageEl || (allowGlobal ? doc.body : null);
  if (scopeEl) {
    try {
      const textEls = Array.from(scopeEl.querySelectorAll('span, p, div')).filter(el =>
        !isPrismElement(el) && el.childElementCount === 0 && (el.textContent || '').trim().length > 0
      );

      // Direct matches containing the exact term
      const directMatches = textEls
        .map((el, idx) => ({ el, idx }))
        .filter(({ el }) => el.textContent.replace(/\s+/g, ' ').toLowerCase().includes(termLower));

      if (directMatches.length > 0) {
        // Score all matches by context; pick best
        let best = directMatches[0];
        if (directMatches.length > 1) {
          let bestScore = -1;
          for (const m of directMatches) {
            const s = scoreEl(m.el, textEls, m.idx);
            if (s > bestScore) { bestScore = s; best = m; }
          }
        }
        const range = createRangeForText(doc, best.el, termToHighlight);
        if (range) {
          console.log('[Prism:pdf] Strategy 1: direct DOM match for term:', termToHighlight);
          return { element: best.el, range, term: termToHighlight };
        }
        // Fallback: range over whole element
        try {
          const r = doc.createRange(); r.selectNodeContents(best.el);
          return { element: best.el, range: r, term: termToHighlight };
        } catch(_) {}
      }

      // Term split across adjacent spans
      for (let i = 0; i < textEls.length - 1; i++) {
        const c2 = (textEls[i].textContent + textEls[i + 1].textContent).toLowerCase();
        if (c2.includes(termLower)) {
          const r = doc.createRange();
          r.setStart(textEls[i].firstChild || textEls[i], 0);
          r.setEnd(textEls[i + 1].firstChild || textEls[i + 1], textEls[i + 1].textContent.length);
          console.log('[Prism:pdf] Strategy 1: split-span match across 2 spans');
          return { element: textEls[i], range: r, term: termToHighlight };
        }
      }
    } catch (e) {
      console.log('[Prism:pdf] Strategy 1 error:', e);
    }
  }

  // Build context candidates for win.find()
  const candidates = [];
  const words = cleanSnippet.split(/\s+/).filter(Boolean);
  if (cleanSnippet.toLowerCase().includes(termLower)) {
    const termWords = termToHighlight.split(/\s+/).filter(Boolean);
    const kwIdx = words.findIndex(w => w.toLowerCase().includes(termWords[0].toLowerCase()));
    if (kwIdx !== -1) {
      const s2 = Math.max(0, kwIdx - 2), e2 = Math.min(words.length, kwIdx + termWords.length + 2);
      const pWide = words.slice(s2, e2).join(' ');
      if (pWide.length > termToHighlight.length) candidates.push(pWide);
      const s1 = Math.max(0, kwIdx - 1), e1 = Math.min(words.length, kwIdx + termWords.length + 1);
      const pTight = words.slice(s1, e1).join(' ');
      if (pTight.length > termToHighlight.length && pTight !== pWide) candidates.push(pTight);
    }
  }
  candidates.push(termToHighlight);
  const seen = new Set();
  const uniqueCandidates = candidates.filter(c => {
    if (!c || c.length < 2 || seen.has(c.toLowerCase())) return false;
    seen.add(c.toLowerCase()); return true;
  });

  // â”€â”€ Strategy 2: window.find() to locate region, then createRangeForText to narrow â”€â”€
  // IMPORTANT: Never call win.find() a second time for narrowing â€” it jumps pages.
  if (win && typeof win.find === 'function') {
    try {
      const sc = getPdfScrollContainer(doc);
      const isAtPage1 = sc && sc.scrollTop < 100;
      if (!(pageNum > 1 && isAtPage1 && !allowGlobal)) {
        // Seed cursor to start of target page
        if (!allowGlobal && targetPageEl && win.getSelection) {
          try {
            const sel = win.getSelection();
            sel.removeAllRanges();
            const r = doc.createRange();
            r.selectNodeContents(targetPageEl);
            r.collapse(true);
            sel.addRange(r);
          } catch (_) {}
        }

        for (const candidate of uniqueCandidates) {
          try {
            const wrapAround = allowGlobal || !pageNum || pageNum <= 1;
            const found = win.find(candidate, false, false, wrapAround, false, false, false);
            if (!found) continue;

            const sel = win.getSelection();
            if (!sel || sel.rangeCount === 0) continue;

            let range = sel.getRangeAt(0);
            let node = range.commonAncestorContainer;
            let el = node.nodeType === 1 ? node : node.parentElement;

            // Skip Prism UI matches
            if (el && isPrismElement(el)) {
              let advanced = false;
              for (let skip = 0; skip < 5; skip++) {
                if (!win.find(candidate, false, false, false, false, false, false)) break;
                const s2 = win.getSelection();
                if (s2 && s2.rangeCount > 0) {
                  range = s2.getRangeAt(0);
                  node = range.commonAncestorContainer;
                  el = node.nodeType === 1 ? node : node.parentElement;
                  if (el && !isPrismElement(el)) { advanced = true; break; }
                }
              }
              if (!advanced) continue;
            }

            if (!el || isPrismElement(el)) continue;

            console.log('[Prism:pdf] Strategy 2: win.find matched:', candidate);

            // Narrow to exact term via DOM only (never a second win.find)
            const exactRange = createRangeForText(doc, el, termToHighlight)
                            || createRangeForText(doc, el.parentElement, termToHighlight);
            const finalRange = exactRange || range.cloneRange();
            return { element: el, range: finalRange, term: termToHighlight };
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  // ── Strategy 3: TreeWalker on page scope ─────────────────────────────────────
  try {
    const root = targetPageEl || (allowGlobal ? doc.body : null);
    if (root) {
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue) continue;
        const idx = node.nodeValue.toLowerCase().indexOf(termLower);
        if (idx !== -1) {
          const p = node.parentElement;
          if (p && !isPrismElement(p)) {
            const r = doc.createRange();
            r.setStart(node, idx);
            r.setEnd(node, Math.min(node.nodeValue.length, idx + termToHighlight.length));
            console.log('[Prism:pdf] Strategy 3: TreeWalker match for:', termToHighlight);
            return { element: p, range: r, term: termToHighlight };
          }
        }
      }
    }
  } catch (_) {}

  return null;
}

// ── Element Real Highlight ───────────────────────────────────────────────────
function highlightMatchedElement(match) {
  if (!match) return;
  const element = match.element || match;
  const range = match.range;
  const doc = element.ownerDocument || document;
  const win = doc.defaultView || window;

  console.log('[Prism:pdf] highlightMatchedElement: scrolling and applying whole-line highlighter');

  // 1. Instant scroll to target — settled synchronously before measuring coordinates
  try {
    const scrollTarget = (range && range.startContainer)
      ? (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)
      : element;
    if (scrollTarget && typeof scrollTarget.scrollIntoView === 'function') {
      scrollTarget.scrollIntoView({ behavior: 'instant', block: 'center' });
    } else if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ behavior: 'instant', block: 'center' });
    }
  } catch (_) {}

  // 2. Native text selection on exact range
  if (range && win.getSelection) {
    try {
      const sel = win.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
  }

  // 3. Real Whole-Line Highlighter Strips (Yellow Pen)
  //    Draws authentic highlighter strips covering the entire line containing the match.
  //    Works over Google Drive canvas-rendered PDF pages.
  const applyStrips = () => {
    try {
      const lineEl = (range && range.startContainer)
        ? (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)
        : element;
      if (!lineEl || lineEl === doc.body || lineEl === doc.documentElement) return;

      const lRect = lineEl.getBoundingClientRect();
      let lineLeft = lRect.left;
      let lineRight = lRect.right;
      let lineTop = lRect.top;
      let lineBottom = lRect.bottom;

      // Expand horizontally to cover any sibling spans sharing the same line baseline
      if (lineEl.parentElement) {
        const sibs = lineEl.parentElement.children;
        for (let i = 0; i < sibs.length; i++) {
          const s = sibs[i];
          if (s === lineEl) continue;
          const text = (s.textContent || '').trim();
          if (!text) continue;
          const sr = s.getBoundingClientRect();
          if (sr.width > 0 && sr.height > 4 && Math.abs(sr.top - lineTop) < 6) {
            lineLeft = Math.min(lineLeft, sr.left);
            lineRight = Math.max(lineRight, sr.right);
            lineTop = Math.min(lineTop, sr.top);
            lineBottom = Math.max(lineBottom, sr.bottom);
          }
        }
      }

      // Group multi-line range rects if range spans across multiple lines
      const lineBoxes = [];
      if (range) {
        const rRects = range.getClientRects();
        for (let i = 0; i < rRects.length; i++) {
          const rr = rRects[i];
          if (rr.width <= 2 || rr.height <= 2) continue;
          let box = lineBoxes.find(b => Math.abs(b.top - rr.top) < 8);
          if (!box) {
            box = { left: rr.left, right: rr.right, top: rr.top, bottom: rr.bottom };
            lineBoxes.push(box);
          } else {
            box.left = Math.min(box.left, rr.left);
            box.right = Math.max(box.right, rr.right);
            box.top = Math.min(box.top, rr.top);
            box.bottom = Math.max(box.bottom, rr.bottom);
          }
        }
      }

      // Ensure primary lineEl bounds are represented in lineBoxes
      if (lineBoxes.length === 0) {
        lineBoxes.push({ left: lineLeft, right: lineRight, top: lineTop, bottom: lineBottom });
      } else {
        for (const box of lineBoxes) {
          if (Math.abs(box.top - lineTop) < 8) {
            box.left = Math.min(box.left, lineLeft);
            box.right = Math.max(box.right, lineRight);
            box.top = Math.min(box.top, lineTop);
            box.bottom = Math.max(box.bottom, lineBottom);
          }
          if (lineEl.parentElement) {
            const sibs = lineEl.parentElement.children;
            for (let i = 0; i < sibs.length; i++) {
              const s = sibs[i];
              if (!s.textContent || !s.textContent.trim()) continue;
              const sr = s.getBoundingClientRect();
              if (sr.width > 0 && sr.height > 4 && Math.abs(sr.top - box.top) < 6) {
                box.left = Math.min(box.left, sr.left);
                box.right = Math.max(box.right, sr.right);
                box.top = Math.min(box.top, sr.top);
                box.bottom = Math.max(box.bottom, sr.bottom);
              }
            }
          }
        }
      }

      // Target page container for positioning (moves with scroll)
      const pageContainer = element.closest('.ndfHFb-c4YZDc-DAR3ue, .drive-viewer-page, [data-page-number], [role="region"]')
        || doc.querySelector('.ndfHFb-c4YZDc-DAR3ue')
        || element.closest('div[style*="position"]')
        || doc.body;

      const isPositioned = pageContainer && pageContainer !== doc.body && pageContainer !== doc.documentElement;
      if (isPositioned) {
        const compPos = win.getComputedStyle(pageContainer).position;
        if (compPos === 'static') {
          pageContainer.style.position = 'relative';
        }
      }
      const container = isPositioned ? pageContainer : (doc.body || doc.documentElement);

      let offsetX = 0;
      let offsetY = 0;
      if (isPositioned) {
        const pRect = pageContainer.getBoundingClientRect();
        const pBorderLeft = pageContainer.clientLeft || 0;
        const pBorderTop = pageContainer.clientTop || 0;
        offsetX = -pRect.left - pBorderLeft;
        offsetY = -pRect.top - pBorderTop;
      } else {
        offsetX = win.pageXOffset || doc.documentElement.scrollLeft || 0;
        offsetY = win.pageYOffset || doc.documentElement.scrollTop || 0;
      }

      // Remove existing highlighter strips first
      doc.querySelectorAll('.prism-real-highlighter').forEach(s => s.remove());

      const padX = 6;
      const padY = 3;

      for (const box of lineBoxes) {
        const bWidth = box.right - box.left;
        const bHeight = box.bottom - box.top;
        if (bWidth <= 2 || bHeight <= 2) continue;

        const sLeft = Math.round(box.left + offsetX - padX);
        const sTop = Math.round(box.top + offsetY - padY);
        const sWidth = Math.round(Math.max(bWidth + (padX * 2), 40));
        const sHeight = Math.round(Math.max(bHeight + (padY * 2), 16));

        const strip = doc.createElement('div');
        strip.className = 'prism-real-highlighter';
        strip.style.cssText = `
          position: absolute;
          left: ${sLeft}px;
          top: ${sTop}px;
          width: ${sWidth}px;
          height: ${sHeight}px;
          background-color: rgba(255, 235, 59, 0.65);
          border-radius: 3px;
          pointer-events: none;
          z-index: 2147483640;
          mix-blend-mode: multiply;
          box-shadow: 0 0 8px rgba(255, 235, 59, 0.85);
          transition: opacity 1.2s ease;
        `;
        container.appendChild(strip);

        // Fade out gently after 9 seconds
        setTimeout(() => {
          try {
            strip.style.opacity = '0';
            setTimeout(() => { try { strip.remove(); } catch(_) {} }, 1200);
          } catch (_) {}
        }, 9000);
      }

      console.log('[Prism:pdf] Whole-line highlighter strips created:', lineBoxes.length);
    } catch (e) {
      console.log('[Prism:pdf] Error applying whole-line highlighter strips:', e);
    }
  };

  // Apply immediately once instant scroll settles, and re-check at 80ms and 250ms
  applyStrips();
  setTimeout(applyStrips, 80);
  setTimeout(applyStrips, 250);

  // 4a. CSS Custom Highlight API as secondary reinforcement
  try {
    if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined' && range) {
      CSS.highlights.delete('prism-match');
      CSS.highlights.set('prism-match', new Highlight(range));
      if (!doc.getElementById('prism-hl-style')) {
        const style = doc.createElement('style');
        style.id = 'prism-hl-style';
        style.textContent = '::highlight(prism-match){background-color:rgba(255,215,0,0.8)!important;color:inherit!important;}';
        (doc.head || doc.body).appendChild(style);
      }
      setTimeout(() => { try { CSS.highlights.delete('prism-match'); } catch(_) {} }, 9000);
    }
  } catch (_) {}

  // 4b. Background color on span as secondary reinforcement
  try {
    let lineEl = (range && range.startContainer)
      ? (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)
      : element;
    if (lineEl && lineEl !== doc.body && lineEl !== doc.documentElement) {
      const prev = { bg: lineEl.style.backgroundColor, ol: lineEl.style.outline };
      lineEl.style.setProperty('background-color', 'rgba(255, 235, 59, 0.7)', 'important');
      lineEl.style.setProperty('outline', '2px solid rgba(220, 180, 0, 0.9)', 'important');
      setTimeout(() => {
        try { lineEl.style.backgroundColor = prev.bg || ''; lineEl.style.outline = prev.ol || ''; } catch(_) {}
      }, 9000);
    }
  } catch (_) {}
}



function getBestFindPhrase(targetText, keyword) {
  const clean = (targetText || '')
    .replace(/^[â€¦\.][â€¦\.\s]*/, '')
    .replace(/[â€¦\.][â€¦\.\s]*$/, '')
    .replace(/^["'â€œâ€˜]+/, '')
    .replace(/["'â€â€™]+$/, '')
    .replace(/(\w+)-\s+(\w+)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) return (keyword || '').trim();

  const words = clean.split(' ').filter(Boolean);
  const kw = (keyword || '').trim().toLowerCase();

  // If keyword is present in clean text, take 3-4 words centered on keyword
  if (kw && clean.toLowerCase().includes(kw)) {
    const kwIdx = words.findIndex(w => w.toLowerCase().includes(kw));
    if (kwIdx !== -1) {
      const start = Math.max(0, kwIdx - 1);
      const end = Math.min(words.length, kwIdx + 3);
      const phrase = words.slice(start, end).join(' ');
      if (phrase.split(' ').length >= 2 && phrase.length >= 8) {
        return phrase;
      }
    }
  }

  // Otherwise take the first 4 words of the clean snippet
  if (words.length >= 4) {
    return words.slice(0, 4).join(' ');
  }

  return clean;
}

// â”€â”€ Viewer Find Bar Trigger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function triggerViewerFind(doc, term) {
  if (!doc || !term) return false;
  try {
    const win = doc.defaultView || window;

    // Method 1: Click any search/find button in toolbar
    try {
      const searchBtns = doc.querySelectorAll(
        '[aria-label*="Search in document" i], ' +
        '[aria-label*="Find in document" i], ' +
        '[aria-label*="Search" i]:not([aria-label*="Drive" i]):not([aria-label*="Google" i]), ' +
        '[aria-label*="Find" i]:not([aria-label*="Drive" i]), ' +
        '[data-tooltip*="Search in document" i], ' +
        '[data-tooltip*="Find" i]'
      );
      for (const btn of searchBtns) {
        if (btn.closest && btn.closest('.ds-side-pane, #ds-side-pane, .ds-search-box')) continue;
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          clickElement(btn);
          break;
        }
      }
    } catch (_) {}

    // Method 2: Dispatched Ctrl+F shortcut
    try {
      ['keydown', 'keypress', 'keyup'].forEach(type => {
        const ev = new KeyboardEvent(type, {
          key: 'f', code: 'KeyF', keyCode: 70, which: 70,
          ctrlKey: true, bubbles: true, cancelable: true, composed: true, view: win
        });
        (doc.activeElement || doc.body || doc.documentElement).dispatchEvent(ev);
      });
    } catch (_) {}

    // Method 3: Poll for Find input to appear, fill and submit
    let pollCount = 0;
    const maxPolls = 10;
    const pollInterval = setInterval(() => {
      pollCount++;
      const inputSelectors = [
        'input.ndfHFb-c4YZDc-W7YS6d',
        'input[aria-label*="Search in document" i]',
        'input[aria-label*="Find in document" i]',
        'input[aria-label*="Search" i]:not([aria-label*="Drive" i]):not([aria-label*="Google" i])',
        'input[aria-label*="Find" i]:not([aria-label*="Drive" i])',
        '.drive-viewer-search-box input',
        'input[type="search"]'
      ];

      let input = null;
      for (const sel of inputSelectors) {
        try {
          const found = doc.querySelector(sel);
          if (found && !found.closest('.ds-side-pane, #ds-side-pane, .ds-search-box')) {
            const rect = found.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              input = found;
              break;
            }
          }
        } catch (_) {}
      }

      if (input) {
        clearInterval(pollInterval);
        try {
          input.focus();
          input.select();
          const nativeSetter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(input, term);
          else input.value = term;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));

          ['keydown', 'keypress', 'keyup'].forEach(type => {
            input.dispatchEvent(new KeyboardEvent(type, {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13,
              bubbles: true, cancelable: true, composed: true, view: win
            }));
          });
          console.log('[Prism:pdf] triggerViewerFind successfully submitted term:', term);
        } catch (e) {
          console.log('[Prism:pdf] Error submitting find term:', e);
        }
      } else if (pollCount >= maxPolls) {
        clearInterval(pollInterval);
      }
    }, 250);

    return true;
  } catch (_) {
    return false;
  }
}

// â”€â”€ Cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function clearPendingJump() {
  try {
    chrome.storage.local.remove('prismPendingPdfJump');
  } catch (_) {}
}

// â”€â”€ Google Sheets Deep Link / Row Navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let isSheetJumping = false;

function initSheetDeepLink() {
  window.addEventListener('hashchange', handleSheetHashChange);
  processSheetHash(initialHash || window.location.hash);
}

function handleSheetHashChange() {
  processSheetHash(window.location.hash);
}

function processSheetHash(hash) {
  if (!hash || isSheetJumping) return;

  let range = '';
  let row = '';
  let findText = '';

  const mRange = hash.match(/range=([A-Za-z0-9:]+)/i);
  if (mRange) range = decodeURIComponent(mRange[1]);

  const mRow = hash.match(/row=(\d+)/i);
  if (mRow) row = mRow[1];

  const mFind = hash.match(/find-text=([^&]+)/i);
  if (mFind) findText = decodeURIComponent(mFind[1]);

  if (!range && row) range = `A${row}`;
  if (!range && !findText) return;

  jumpToSheetRow(range, row, findText);
}

function getSheetNameBoxInput() {
  const el = document.getElementById('t-name-box');
  if (el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el;
    const inp = el.querySelector('input, textarea');
    if (inp) return inp;
    return el;
  }
  return document.querySelector('input[aria-label*="Name box" i]') ||
         document.querySelector('.name-box input') ||
         document.querySelector('[id*="name-box"]');
}

function getActiveSheetGid() {
  const tab = document.querySelector('.docs-sheet-active-tab') || document.querySelector('[role="tab"][aria-selected="true"]');
  if (tab) {
    const dataId = tab.getAttribute('data-id');
    if (dataId) return dataId;
    const m = (tab.id || '').match(/\d+/);
    if (m) return m[0];
  }
  const hashM = (window.location.hash || '').match(/gid=(\d+)/);
  if (hashM) return hashM[1];
  return null;
}

async function jumpToSheetRow(targetRange, rowNumber, findText) {
  isSheetJumping = true;

  const wasBackgrounded = document.visibilityState !== 'visible';
  await waitForVisible();
  if (wasBackgrounded) {
    await sleep(600);
  }

  const targetLabel = rowNumber ? `Row ${rowNumber}` : targetRange;

  // Wait for Google Sheets UI / tabs to load (up to 8s)
  for (let i = 0; i < 25; i++) {
    const tab = document.querySelector('.docs-sheet-active-tab') || document.getElementById('t-name-box');
    if (tab) break;
    await sleep(300);
  }

  // Ensure URL hash has the active gid and range so Sheets router selects the range
  try {
    const activeGid = getActiveSheetGid();
    if (activeGid && targetRange) {
      const neededHash = `#gid=${activeGid}&range=${targetRange}`;
      if (!window.location.hash.includes(`range=${targetRange}`)) {
        window.location.hash = neededHash;
      }
    }
  } catch (_) {}

  // Also attempt Name Box navigation
  const nameBox = getSheetNameBoxInput();
  if (nameBox && targetRange) {
    try {
      const input = nameBox.tagName === 'INPUT' || nameBox.tagName === 'TEXTAREA' ? nameBox : nameBox.querySelector('input, textarea');
      if (input) {
        input.focus();
        input.click();
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(input, targetRange);
        else input.value = targetRange;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        ['keydown', 'keypress', 'keyup'].forEach(type => {
          input.dispatchEvent(new KeyboardEvent(type, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13,
            bubbles: true, cancelable: true, view: window
          }));
        });
      }
    } catch (_) {}
  }

  const msg = `${targetLabel} in sheet${findText ? ` Â· Match: "${findText}"` : ''}`;
  showNotification(msg);
  isSheetJumping = false;
}

// Start execution
const currentApp = detectApp();
if (currentApp !== 'utility') {
  console.log('[Prism:doc] content-doc.js loaded, app:', currentApp, 'URL:', window.location.href.slice(0, 80), 'isTop:', window === window.top);
  if (currentApp === 'docs') {
    initDeepLink();
  } else if (currentApp === 'sheets') {
    initSheetDeepLink();
  } else if (currentApp === 'preview') {
    initPdfDeepLink();
  }
}
