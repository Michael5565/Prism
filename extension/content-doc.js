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
let accentHue = 225;              // 0–360
let showBorder = true;
let showQuickToggle = true;
let instantRepaint = false;
// Per-surface switches. Docs documents are always themed (the core engine);
// every other surface can be left to the browser (e.g. Edge's auto-dark flag)
// to avoid double-darkening. Extensions cannot read edge://flags, so this is
// a manual switch per surface.
let surfaces = { sheets: true, drive: true, docshome: true };

// Premium / trial — dark mode uses the same entitlement as search:
// 7-day trial, then Pro only.
let darkIsPremium = false;
let darkInstallTime = 0;
let darkLicenseExpiresAt = 0;
const PRISM_TRIAL_MS = 7 * 24 * 60 * 60 * 1000;

function trialActive() {
  const start = darkInstallTime || Date.now();
  return (Date.now() - start) < PRISM_TRIAL_MS;
}
function entitled() {
  return (darkIsPremium && (!darkLicenseExpiresAt || Date.now() < darkLicenseExpiresAt)) || trialActive();
}

function darkEnabled() {
  if (!entitled()) return false;
  if (!isDocsDarkMode) return false;
  const a = detectApp();
  if (a === 'docs') return true;
  // Removed surfaces: Slides editor + PDF/file preview always stay light
  // so decks and documents keep native colors.
  if (a === 'slides' || a === 'preview') return false;
  return surfaces[a] !== false;
}

// Read preferences immediately at document_start to avoid white flash
const PRISM_KEYS = ['docsDarkMode', 'docsDarkColor', 'docsDocColor', 'docsTextColor', 'docsAccentHue', 'docsShowBorder', 'docsShowQuickToggle', 'docsInstantRepaint', 'docsSurfaces', 'prismPremium', 'prismLicenseExpiresAt', 'prismInstallTime'];

function readAndApply() {
  try {
    chrome.storage.local.get(PRISM_KEYS, (res) => {
      snapshotFromStorage(res);
    });
  } catch (e) {
    try { applyDarkMode(darkEnabled()); } catch (_) {}
  }
}

// Signature of the currently applied settings — used to detect changes that
// landed while the tab was hidden (the popup writes colors while Docs sits
// in the background, and storage events can be delayed for hidden tabs).
function prismSettingsSig() {
  return [isDocsDarkMode, darkColor, hasCustomBg, docColor, textColorSetting,
    accentHue, showBorder, showQuickToggle, instantRepaint,
    darkIsPremium, darkInstallTime, JSON.stringify(surfaces)].join('|');
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
    !!res.prismPremium,
    res.prismLicenseExpiresAt || 0,
    res.prismInstallTime || darkInstallTime || 0,
    JSON.stringify(surf)].join('|');
}
let prismLastSig = '';

function snapshotFromStorage(res) {
  isDocsDarkMode = res.docsDarkMode !== false;
  darkColor = res.docsDarkColor || '#1a1a1a';
  hasCustomBg = !!res.docsDarkColor;
  docColor = res.docsDocColor || '#2b2f36';
  textColorSetting = res.docsTextColor || '#e2e8f0';
  accentHue = Number.isFinite(+res.docsAccentHue) ? +res.docsAccentHue : 225;
  showBorder = res.docsShowBorder !== false;
  showQuickToggle = res.docsShowQuickToggle !== false;
  instantRepaint = res.docsInstantRepaint === true;
  darkIsPremium = !!res.prismPremium;
  darkLicenseExpiresAt = Number(res.prismLicenseExpiresAt) || 0;
  darkInstallTime = res.prismInstallTime || darkInstallTime || Date.now();
  if (!res.prismInstallTime) {
    try { chrome.storage.local.set({ prismInstallTime: darkInstallTime }); } catch (_) {}
  }
  if (res.docsSurfaces) surfaces = { ...surfaces, ...res.docsSurfaces };
  prismLastSig = prismSettingsSig();

  applyDarkMode(darkEnabled());
  injectQuickToggleButton();
}

readAndApply();

// SPA navigation (e.g. Docs home list → document) doesn't re-run content
// scripts, so the theme would stay stuck on the previous surface. Re-sync
// whenever the URL changes.
let lastPrismUrl = '';
try { lastPrismUrl = window.location.href; } catch (_) {}
setInterval(() => {
  try {
    if (window.location.href !== lastPrismUrl) {
      lastPrismUrl = window.location.href;
      readAndApply();
      if (detectApp() === 'docs') initDeepLink();
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
  if (changes.prismPremium) {
    darkIsPremium = !!changes.prismPremium.newValue;
    changed = true;
  }
  if (changes.prismLicenseExpiresAt) {
    darkLicenseExpiresAt = Number(changes.prismLicenseExpiresAt.newValue) || 0;
    changed = true;
  }
  if (changes.prismInstallTime) {
    darkInstallTime = changes.prismInstallTime.newValue || darkInstallTime;
    changed = true;
  }

  if (changed) {
    applyDarkMode(darkEnabled());
    updateQuickToggleButton();
    prismLastSig = prismSettingsSig();
  }
});

// Popup color picks land while this tab sits in the background. On return,
// re-read and re-apply only if something actually changed — the attribute
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
    if (p.includes('/spreadsheets/')) return 'sheets';
    if (/\/presentation\/d\//.test(p)) return 'slides';
    if (p.includes('/presentation/')) return 'docshome';
    if (p.includes('/file/') || p.includes('/preview')) return 'preview';
    if (/\/document\/d\//.test(p)) return 'docs';
    try {
      if (window.location.hostname.includes('drive.google.com')) return 'drive';
    } catch (_) {}
    return 'docshome';
  } catch (_) { return 'docs'; }
}

function applyDarkMode(enable) {
  const html = document.documentElement;
  const app = detectApp();
  // Docs/Sheets editors get our hand theme + canvas engine (the document).
  // Drive + homepages get Edge-model inversion. Slides editor + PDF/file
  // preview stay light (removed surfaces) — not even inversion.
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
    // …document editor sheet from the separate Document setting
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

// ── Quick Toggle Floating Button ─────────────────────────────────────────────

function injectQuickToggleButton() {
  // All Docs/Sheets/Drive tabs (not just documents) — visibility is gated
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
    if (!entitled() && !isDocsDarkMode) {
      showNotification('Prism trial expired — activate Pro with your license key to use dark mode.');
      return;
    }
    isDocsDarkMode = !isDocsDarkMode;
    applyDarkMode(darkEnabled());
    updateQuickToggleButtonIcon(btn, darkEnabled());
    try { chrome.storage.local.set({ docsDarkMode: isDocsDarkMode }); } catch (_) {}
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

// ── Deep-Link / Native Find ──────────────────────────────────────────────────

// Captured immediately (this file now runs at document_start) so we grab
// the fragment before any other script on the page has a chance to touch it.
const initialHash = window.location.hash;

let isSearching = false;

function initDeepLink() {
  window.addEventListener('hashchange', handleHashChange);
  processHash(initialHash);
}

function handleHashChange() {
  processHash(window.location.hash);
}

function processHash(hash) {
  if (!hash || !hash.startsWith('#find-text=')) return;
  const encodedText = hash.substring('#find-text='.length);
  const targetText = decodeURIComponent(encodedText);
  if (targetText && !isSearching) {
    console.log(`Deep-link detected. Searching for snippet: "${targetText}"`);
    startScrollingSearch(targetText);
  }
}

async function startScrollingSearch(targetText) {
  isSearching = true;

  const wasBackgrounded = document.visibilityState !== 'visible';
  await waitForVisible();
  if (wasBackgrounded) {
    console.log('[nativeFind] Tab was backgrounded — giving it a moment to catch up after becoming visible.');
    await sleep(800);
  }

  window.focus();
  showNotification('Locating paragraph in document…');

  const editorLoaded = await waitForEditorLoad();
  if (!editorLoaded) {
    console.warn('Google Docs editor failed to load or took too long.');
    isSearching = false;
    return;
  }

  console.log('Editor loaded. Starting native Find search...');
  const foundIt = await triggerNativeFind(targetText);

  if (foundIt) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  } else {
    showNotification('Couldn\'t jump to the match for read-only files. Try Cmd/Ctrl+F to search manually.');
  }

  isSearching = false;
}

function waitForVisible() {
  return new Promise((resolve) => {
    if (document.visibilityState === 'visible') { resolve(); return; }
    console.log('[nativeFind] Tab not immediately visible — waiting for it to become visible before searching.');

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
    const safetyTimer = setTimeout(() => {
      console.log('[nativeFind] Gave up waiting for visibilitychange after 2s — proceeding anyway.');
      finish();
    }, 2000);
  });
}

async function triggerNativeFind(targetText) {
  console.log('[nativeFind] target:', targetText);

  const menuOpened = await openFindAndReplaceDialog();
  let inputReady = false;

  if (menuOpened) {
    inputReady = await waitForFindInput(15);
    if (!inputReady) {
      console.log('[nativeFind] Menu click didn\'t open the dialog — using the ⌘+Shift+H keyboard shortcut instead.');
    }
  } else {
    console.log('[nativeFind] Could not open Find and replace via the Edit menu — using the ⌘+Shift+H keyboard shortcut instead.');
  }

  if (!inputReady) {
    const editor = document.querySelector('.kix-appview-editor');
    if (editor) clickElement(editor);
    await sleep(200);

    dispatchFindReplaceShortcut();
    inputReady = await waitForFindInput();
    if (!inputReady) {
      console.warn('[nativeFind] Find input still never appeared, even via the keyboard shortcut fallback. See getFindInput().');
      return false;
    }
    console.log('[nativeFind] Keyboard shortcut fallback worked — Find input appeared.');
  }

  console.log('[nativeFind] Find and replace dialog ready.');

  const candidates = buildSearchCandidates(targetText);
  for (const candidate of candidates) {
    console.log(`[nativeFind] trying candidate: "${candidate}"`);
    const matched = await runFindQuery(candidate);
    console.log(`[nativeFind] candidate ${matched ? 'MATCHED' : 'no match'}`);
    if (matched) {
      await sleep(900);
      closeFindDialog();
      return true;
    }
  }

  closeFindDialog();
  return false;
}

function dispatchFindReplaceShortcut() {
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const eventInit = {
    key: 'h', code: 'KeyH', shiftKey: true,
    metaKey: isMac, ctrlKey: !isMac,
    bubbles: true, cancelable: true,
  };
  const target = document.activeElement || document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
  target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
}

function openFindAndReplaceDialog() {
  return new Promise((resolve) => {
    const editMenuBtn = document.querySelector('#docs-edit-menu');
    if (!editMenuBtn) { console.warn('[nativeFind] #docs-edit-menu not found.'); resolve(false); return; }

    clickElement(editMenuBtn);

    let attempts = 0;
    const maxAttempts = 30;
    const interval = setInterval(() => {
      attempts++;
      const menuItem = findMenuItemByText('Find and replace');
      if (menuItem) { clearInterval(interval); clickMenuItem(menuItem); resolve(true); return; }
      if (attempts >= maxAttempts) { clearInterval(interval); resolve(false); }
    }, 100);
  });
}

function findMenuItemByText(text) {
  const items = document.querySelectorAll('[role="menuitem"]');
  for (const item of items) {
    if (item.textContent && item.textContent.trim().startsWith(text)) return item;
  }
  return null;
}

function clickElement(el) {
  ['mousedown', 'mouseup', 'click'].forEach((type) => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  });
}

function clickMenuItem(el) {
  ['mouseover', 'mouseenter', 'mousemove'].forEach((type) => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  });
  clickElement(el);
}

function waitForFindInput(maxAttempts = 50) {
  return new Promise((resolve) => {
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const input = getFindInput();
      if (input && input.offsetParent !== null) { clearInterval(interval); resolve(true); }
      else if (attempts >= maxAttempts) { clearInterval(interval); resolve(false); }
    }, 100);
  });
}

function getFindInput() {
  return document.querySelector('input[aria-label="Find"]')
    || document.querySelector('input[class*="WizTextFieldOutlined-text-field__input"]');
}

function closeFindDialog() {
  const closeBtn = document.querySelector('[aria-label="Close"]');
  if (closeBtn) clickElement(closeBtn);
}

function buildSearchCandidates(targetText) {
  const trimmed = targetText.trim();
  const candidates = [trimmed];
  if (trimmed.length > 40) {
    const mid = Math.floor(trimmed.length / 2);
    candidates.push(trimmed.substring(Math.max(0, mid - 20), mid + 20).trim());
  }
  if (trimmed.length > 20) {
    candidates.push(trimmed.substring(0, 20).trim());
  }
  return candidates;
}

function getFindBarContainer() {
  const input = getFindInput();
  if (!input) return null;
  let el = input;
  while (el && el !== document.body) {
    if (el.textContent && el.textContent.includes('Find and replace')) return el;
    el = el.parentElement;
  }
  return input.parentElement;
}

function runFindQuery(text) {
  return new Promise((resolve) => {
    const input = getFindInput();
    if (!input) { resolve(false); return; }

    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    nativeSetter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));

    setTimeout(() => {
      const container = getFindBarContainer();
      const containerText = container ? container.textContent : '';
      console.log('[nativeFind] find dialog text after query:', JSON.stringify(containerText));
      const noResults = /no results/i.test(containerText);
      const hasCountPattern = /\d+\s*(of|\/)\s*\d+/i.test(containerText);
      resolve(!noResults && hasCountPattern);
    }, 600);
  });
}

function waitForEditorLoad() {
  return new Promise((resolve) => {
    let checkCount = 0;
    const interval = setInterval(() => {
      const editor = document.querySelector('.kix-appview-editor');
      const toolbar = document.querySelector('#docs-toolbar, #docs-edit-menu');
      const ready = editor && toolbar;
      checkCount++;
      if (ready || checkCount > 120) { clearInterval(interval); resolve(!!ready); }
    }, 100);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Shows a premium modern toast notification inside Google Docs.
 */
function showNotification(message) {
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => showNotification(message), { once: true });
    return;
  }

  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed;
    bottom: 30px;
    left: 50%;
    transform: translateX(-50%) translateY(20px);
    background: rgba(30, 30, 30, 0.9);
    color: white;
    padding: 12px 24px;
    border-radius: 12px;
    font-family: 'Outfit', sans-serif;
    font-size: 0.9rem;
    line-height: 1.45;
    max-width: 440px;
    text-align: center;
    z-index: 100000;
    box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.1);
    opacity: 0;
    transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  `;
  toast.innerText = message;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.transform = 'translateX(-50%) translateY(0)';
    toast.style.opacity = '1';
  }, 50);
  
  const displayMs = Math.min(12000, Math.max(4000, message.length * 60));
  setTimeout(() => {
    toast.style.transform = 'translateX(-50%) translateY(20px)';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 400);
  }, displayMs);
}

// Start execution (deep-link search is a Docs-document feature only)
if (detectApp() === 'docs') initDeepLink();
