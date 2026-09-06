// Prism — Popup Controller (synced with popup.html)
// Home (Search + Dark overview) + Dark Settings detail page.
// Wires: search toggle/usage/preview, presets, dark mode, palettes,
// accent hue, page border, quick-toggle, license drawer.

const LICENSE_SERVER = 'https://prism-license-worker.purrapi.workers.dev';
const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_BG = '#1a1a1a';
const DEFAULT_DOC = '#2b2f36';
const DEFAULT_TEXT = '#e2e8f0';
const FREE_SEARCH_LIMIT = 3;
const LICENSE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
function licenseIsLocallyActive(res) {
  return !!res.prismPremium && (!res.prismLicenseExpiresAt || Date.now() < res.prismLicenseExpiresAt);
}

// Business presets — one click sets theme + doc + text + accent.
// Style is always Midnight (no Normal mode).
const BUSINESS_PRESETS = {
  executive: { label: 'Executive', bg: '#1a1a1a', doc: '#2b2f36', text: '#e2e8f0', hue: 225, border: true },
  midnight:  { label: 'Midnight',  bg: '#000000', doc: '#000000', text: '#ffffff', hue: 225, border: true },
  contrast:  { label: 'Contrast',  bg: '#000000', doc: '#000000', text: '#fde047', hue: 48,  border: true },
};

// Light, high-contrast choices for text on dark sheets.
const TEXT_PRESETS = [
  { label: 'Off-White', color: '#e2e8f0' },
  { label: 'White',     color: '#ffffff' },
  { label: 'Warm',      color: '#f5efe6' },
  { label: 'Silver',    color: '#c9cdd3' },
  { label: 'Gray',      color: '#9aa0a6' },
  { label: 'Yellow',    color: '#fde047' },
  { label: 'Orange',    color: '#fb923c' },
  { label: 'Red',       color: '#f87171' },
  { label: 'Pink',      color: '#f472b6' },
  { label: 'Green',     color: '#4ade80' },
  { label: 'Cyan',      color: '#22d3ee' },
  { label: 'Blue',      color: '#8ab4f8' },
];

const DARK_PRESETS = [
  { label: 'Normal',   color: '#1a1a1a' },
  { label: 'Midnight', color: '#000000' },
  { label: 'Obsidian', color: '#121212' },
  { label: 'Abyss',    color: '#0d1117' },
  { label: 'Graphite', color: '#1e1f20' },
  { label: 'Slate',    color: '#1e2430' },
  { label: 'Navy',     color: '#0a0e1a' },
  { label: 'Forest',   color: '#0d1f12' },
  { label: 'Espresso', color: '#1c1008' },
  { label: 'Plum',     color: '#221826' },
  { label: 'Teal',     color: '#0e1f1f' },
  { label: 'Brown',    color: '#201712' },
  { label: 'Blue',     color: '#141c28' },
  { label: 'Green',    color: '#131c15' },
  { label: 'Rose',     color: '#201318' },
  { label: 'Slate+',   color: '#2b2f36' },
];



// 1. i18n
document.querySelectorAll('[data-i18n]').forEach((el) => {
  try {
    const k = el.getAttribute('data-i18n');
    const m = chrome.i18n.getMessage(k);
    if (m) el.textContent = m;
  } catch (_) {}
});

// 1b. Navigation: Home <-> Dark Settings
const pageHome = document.getElementById('pageHome');
const pageDark = document.getElementById('pageDark');
function showPage(name) {
  if (!pageHome || !pageDark) return;
  const toDark = name === 'dark';
  pageDark.classList.toggle('hidden', !toDark);
  pageHome.classList.toggle('hidden', toDark);
  try { chrome.storage.local.set({ prismPopupPage: toDark ? 'dark' : 'home' }); } catch (_) {}
}
const gotoDarkBtn = document.getElementById('gotoDarkSettings');
if (gotoDarkBtn) gotoDarkBtn.addEventListener('click', () => showPage('dark'));
const backBtn = document.getElementById('backToHome');
if (backBtn) backBtn.addEventListener('click', () => showPage('home'));
// Restore last page; default to home (business-clean). Deep-link to dark
// only when the popup was opened from a Docs tab last time is overkill.
try {
  chrome.storage.local.get(['prismPopupPage'], (r) => {
    // Always start on home for a consistent B2B first impression.
    showPage('home');
  });
} catch (_) {}

// 1c. Search card: enable toggle, usage line, example preview
const searchToggle = document.getElementById('searchEnabledToggle');
const searchCard = document.getElementById('searchCard');
const searchUsage = document.getElementById('searchUsage');
const previewBtn = document.getElementById('previewSearchBtn');
const searchPreview = document.getElementById('searchPreview');

function refreshSearchUsage() {
  if (!searchUsage) return;
  chrome.storage.local.get(
    ['prismPremium', 'prismLicenseExpiresAt', 'prismSearchCount', 'prismInstallTime', 'prismSearchEnabled'],
    (res) => {
      const enabled = res.prismSearchEnabled !== false;
      if (!enabled) { searchUsage.innerHTML = 'Search is <strong>paused</strong> — toggle on to resume.'; return; }
      if (licenseIsLocallyActive(res)) { searchUsage.innerHTML = 'Pro · <strong>unlimited</strong> searches'; return; }
      const now = Date.now();
      const start = res.prismInstallTime || now;
      const remaining = TRIAL_DURATION_MS - (now - start);
      if (remaining > 0) {
        const d = Math.max(1, Math.ceil(remaining / 86400000));
        searchUsage.innerHTML = `Trial · <strong>${d}d left</strong> · unlimited searches`;
      } else {
        const used = Math.min(res.prismSearchCount || 0, FREE_SEARCH_LIMIT);
        searchUsage.innerHTML = `Free · <strong>${used}/${FREE_SEARCH_LIMIT}</strong> searches used`;
      }
    }
  );
}

try {
  chrome.storage.local.get(['prismSearchEnabled'], (r) => {
    const on = r.prismSearchEnabled !== false;
    if (searchToggle) searchToggle.checked = on;
    if (searchCard) searchCard.classList.toggle('disabled', !on);
  });
} catch (_) {}
if (searchToggle) {
  searchToggle.addEventListener('change', () => {
    try { chrome.storage.local.set({ prismSearchEnabled: searchToggle.checked }); } catch (_) {}
    if (searchCard) searchCard.classList.toggle('disabled', !searchToggle.checked);
    refreshSearchUsage();
  });
}
if (previewBtn && searchPreview) {
  previewBtn.addEventListener('click', () => {
    const vis = searchPreview.classList.toggle('visible');
    previewBtn.textContent = vis ? 'Hide example' : 'See example';
  });
}
refreshSearchUsage();

// 1d. Business presets
function applyPreset(name) {
  const p = BUSINESS_PRESETS[name];
  if (!p) return;
  chrome.storage.local.set({
    docsDarkColor: p.bg, docsDocColor: p.doc, docsTextColor: p.text,
    docsVariant: 'midnight', docsAccentHue: p.hue, docsShowBorder: p.border,
    prismThemePreset: name,
  });
  syncPaletteUI(p.bg); syncDocUI(p.doc); syncTextUI(p.text);
  syncHueUI(p.hue);
  if (document.getElementById('borderToggle')) document.getElementById('borderToggle').checked = p.border;
  syncPresetUI({ bg: p.bg, doc: p.doc, text: p.text });
}
function syncPresetUI(cur) {
  const norm = (s) => (s || '').toLowerCase();
  let active = '';
  for (const [name, p] of Object.entries(BUSINESS_PRESETS)) {
    if (norm(cur.bg) === norm(p.bg) && norm(cur.doc) === norm(p.doc) && norm(cur.text) === norm(p.text)) { active = name; break; }
  }
  document.querySelectorAll('#presetGrid .preset-card').forEach((b) => {
    b.classList.toggle('active', b.dataset.preset === active);
  });
  const label = active ? BUSINESS_PRESETS[active].label : 'Custom';
  const nameEl = document.getElementById('homePresetName');
  if (nameEl) nameEl.innerHTML = `Preset: <strong>${label}</strong>`;
  const dots = document.getElementById('homePresetDots');
  if (dots && dots.children.length >= 3) {
    dots.children[0].style.background = cur.bg || DEFAULT_BG;
    dots.children[1].style.background = cur.doc || DEFAULT_BG;
    dots.children[2].style.background = cur.text || DEFAULT_TEXT;
  }
}
document.querySelectorAll('#presetGrid .preset-card').forEach((b) => {
  b.addEventListener('click', () => applyPreset(b.dataset.preset));
});
const resetBtn = document.getElementById('resetThemeBtn');
if (resetBtn) resetBtn.addEventListener('click', () => applyPreset('executive'));

// 1e. Advanced collapsible
const advToggle = document.getElementById('advancedToggle');
const advBody = document.getElementById('advancedBody');
const advCaret = document.getElementById('advancedCaret');
const advLabel = document.getElementById('advancedLabel');
if (advToggle && advBody) {
  advToggle.addEventListener('click', () => {
    const vis = advBody.classList.toggle('visible');
    if (advCaret) advCaret.classList.toggle('open', vis);
    if (advLabel) advLabel.textContent = vis
      ? 'Hide advanced — colors, accent, surfaces'
      : 'Show advanced — colors, accent, surfaces';
    advToggle.setAttribute('aria-expanded', vis ? 'true' : 'false');
  });
}

// 2. Status / trial
function updateStatus() {
  chrome.storage.local.get(
    ['prismPremium', 'prismLicenseKey', 'prismUserEmail', 'prismInstallTime', 'prismLicenseExpiresAt'],
    (res) => {
      const isPro = licenseIsLocallyActive(res);
      const now = Date.now();
      let installTime = res.prismInstallTime;
      if (!installTime) {
        installTime = now;
        chrome.storage.local.set({ prismInstallTime: now });
      }

      const remainingMs = TRIAL_DURATION_MS - (now - installTime);
      const isTrial = remainingMs > 0;
      const daysLeft = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));

      const badge = document.getElementById('statusBadge');
      const statusText = document.getElementById('statusText');
      const upgradeLink = document.getElementById('upgradeLink');
      const proConfirmed = document.getElementById('proConfirmed');
      const proEmail = document.getElementById('proEmail');
      const inputGroup = document.getElementById('activateInputGroup');
      const activateTitle = document.getElementById('activateTitle');

      if (!badge || !statusText) return;
      badge.className = 'status-pill';

      if (isPro) {
        badge.classList.add('pro');
        statusText.textContent = 'Pro Active';
        if (upgradeLink) upgradeLink.style.display = 'none';
        if (proConfirmed) proConfirmed.style.display = 'block';
        if (inputGroup) inputGroup.style.display = 'none';
        if (activateTitle) activateTitle.textContent = 'Pro License Active';
        const idStr = res.prismUserEmail || (res.prismLicenseKey ? `${res.prismLicenseKey.slice(0, 10)}…` : 'Activated');
        if (proEmail) proEmail.textContent = `Connected: ${idStr}`;
      } else if (isTrial) {
        badge.classList.add('trial');
        statusText.textContent = `Trial • ${daysLeft}d left`;
        if (proConfirmed) proConfirmed.style.display = 'none';
        if (inputGroup) inputGroup.style.display = 'block';
        if (activateTitle) activateTitle.textContent = 'Activate Pro (License Key)';
        if (upgradeLink) {
          upgradeLink.style.display = 'inline';
          upgradeLink.textContent = 'Upgrade to Pro →';
        }
      } else {
        badge.classList.add('expired');
        statusText.textContent = 'Trial Expired';
        if (proConfirmed) proConfirmed.style.display = 'none';
        if (inputGroup) inputGroup.style.display = 'block';
        if (activateTitle) activateTitle.textContent = 'Activate Pro (License Key)';
        if (upgradeLink) {
          upgradeLink.style.display = 'inline';
          upgradeLink.textContent = 'Unlock Pro →';
        }
      }
    }
  );
}

// 3. Toggles: dark mode, border, quick button (images always stay natural)
const darkToggle = document.getElementById('darkModeToggle');
const borderToggle = document.getElementById('borderToggle');
const quickToggleVisible = document.getElementById('quickToggleVisible');

chrome.storage.local.get(
  ['docsDarkMode', 'docsDarkColor', 'docsDocColor', 'docsTextColor', 'docsVariant', 'docsAccentHue', 'docsShowBorder', 'docsShowQuickToggle'],
  (res) => {
    // Dark toggle state is synced by syncDarkToggle() (entitlement-aware).
    if (borderToggle) borderToggle.checked = res.docsShowBorder !== false;
    if (quickToggleVisible) quickToggleVisible.checked = res.docsShowQuickToggle !== false;
    syncPaletteUI(res.docsDarkColor || DEFAULT_BG);
    syncDocUI(res.docsDocColor || DEFAULT_DOC);
    syncTextUI(res.docsTextColor || DEFAULT_TEXT);
    syncHueUI(Number.isFinite(+res.docsAccentHue) ? +res.docsAccentHue : 225);
    syncPresetUI({ bg: res.docsDarkColor || DEFAULT_BG, doc: res.docsDocColor || DEFAULT_DOC, text: res.docsTextColor || DEFAULT_TEXT });
  }
);

// Effective dark state = switch ON and entitled (trial or Pro).
function syncDarkToggle() {
  chrome.storage.local.get(['docsDarkMode', 'prismPremium', 'prismLicenseExpiresAt', 'prismInstallTime'], (res) => {
    const ok = licenseIsLocallyActive(res) || (Date.now() - (res.prismInstallTime || Date.now())) < TRIAL_DURATION_MS;
    const on = res.docsDarkMode !== false && ok;
    if (darkToggle) darkToggle.checked = on;
    const darkCard = document.getElementById('darkCard');
    if (darkCard) darkCard.classList.toggle('disabled', !on);
  });
}

if (darkToggle) {
  darkToggle.addEventListener('change', () => {
    if (!darkToggle.checked) {
      chrome.storage.local.set({ docsDarkMode: false });
      const darkCard = document.getElementById('darkCard');
      if (darkCard) darkCard.classList.toggle('disabled', true);
      return;
    }
    // Enabling: require trial or Pro, else revert + open activation.
    chrome.storage.local.get(['prismPremium', 'prismLicenseExpiresAt', 'prismInstallTime'], (res) => {
      const ok = licenseIsLocallyActive(res) || (Date.now() - (res.prismInstallTime || Date.now())) < TRIAL_DURATION_MS;
      if (ok) {
        chrome.storage.local.set({ docsDarkMode: true });
        const darkCard = document.getElementById('darkCard');
        if (darkCard) darkCard.classList.toggle('disabled', false);
      } else {
        darkToggle.checked = false;
        const body = document.getElementById('activateBody');
        const caret = document.getElementById('activateCaret');
        if (body) body.classList.add('visible');
        if (caret) caret.classList.add('open');
      }
    });
  });
}
if (borderToggle) {
  borderToggle.addEventListener('change', () => {
    chrome.storage.local.set({ docsShowBorder: borderToggle.checked });
  });
}
if (quickToggleVisible) {
  quickToggleVisible.addEventListener('change', () => {
    chrome.storage.local.set({ docsShowQuickToggle: quickToggleVisible.checked });
  });
}
// 4. Style is always Midnight — migrate any stored Normal once.
try { chrome.storage.local.set({ docsVariant: 'midnight' }); } catch (_) {}

function presetNameFor(list, color) {
  const norm = (color || '').toLowerCase();
  const hit = (list || []).find((p) => (p.color || '').toLowerCase() === norm);
  return hit ? hit.label : 'Custom';
}

// Live combined preview (outer theme bg + doc sheet + text + accent) plus
// named readouts — dark swatches are indistinguishable at small sizes, so
// every pick is shown at real size with its name and hex value.
function syncPreview() {
  const bgEl = document.getElementById('colorPicker');
  const docEl = document.getElementById('docColorPicker');
  const txtEl = document.getElementById('textColorPicker');
  const hueEl = document.getElementById('accentHue');
  const outer = document.getElementById('tpOuter');
  const sheet = document.getElementById('tpSheet');
  const themeLabel = document.getElementById('tpThemeLabel');
  const docLabel = document.getElementById('tpDocLabel');
  if (!outer || !sheet) return;
  const bgV = (bgEl && bgEl.value) || DEFAULT_BG;
  const docV = (docEl && docEl.value) || DEFAULT_DOC;
  const txtV = (txtEl && txtEl.value) || DEFAULT_TEXT;
  const h = parseInt((hueEl && hueEl.value) || '225', 10) || 0;
  outer.style.backgroundColor = bgV;
  sheet.style.backgroundColor = docV;
  if (themeLabel) themeLabel.textContent = `Theme · ${bgV.toUpperCase()}`;
  if (docLabel) docLabel.textContent = `Document · ${docV.toUpperCase()}`;
  outer.querySelectorAll('.tp-line').forEach((el) => { el.style.backgroundColor = txtV; });
  const link = document.getElementById('tpLink');
  if (link) link.style.backgroundColor = `hsl(${h} 70% 65%)`;
}

// Composite mini-cells: Theme cells preview each candidate behind your
// current sheet (and vice versa), so near-identical darks stay readable.
// NOTE: uses getElementById (not the module consts) because the grid build
// blocks run before those const declarations execute — const TDZ would throw.
function paintThemeGrid() {
  const grid = document.getElementById('paletteGrid');
  if (!grid) return;
  const docPicker = document.getElementById('docColorPicker');
  const docV = (docPicker && docPicker.value) || DEFAULT_DOC;
  grid.querySelectorAll('.swatch').forEach((s) => {
    s.style.background = 'var(--surface)';
    const inner = s.querySelector('.mini-sheet');
    if (inner) inner.style.background = s.dataset.color || DEFAULT_BG;
    const label = s.querySelector('.swatch-label');
    if (label) label.textContent = s.dataset.label || s.dataset.color;
  });
}
function paintDocGrid() {
  const grid = document.getElementById('docPaletteGrid');
  if (!grid) return;
  const bgPicker = document.getElementById('colorPicker');
  const bgV = (bgPicker && bgPicker.value) || DEFAULT_BG;
  grid.querySelectorAll('.swatch').forEach((s) => {
    s.style.background = 'var(--surface)';
    const inner = s.querySelector('.mini-sheet');
    if (inner) inner.style.background = s.dataset.color || DEFAULT_BG;
    const label = s.querySelector('.swatch-label');
    if (label) label.textContent = s.dataset.label || s.dataset.color;
  });
}

// 5. Page palette (outer background)
const paletteGrid = document.getElementById('paletteGrid');
const colorPicker = document.getElementById('colorPicker');
const hexInput = document.getElementById('hexInput');

function syncPaletteUI(activeColor) {
  const norm = (activeColor || DEFAULT_BG).toLowerCase();
  if (paletteGrid) {
    paletteGrid.querySelectorAll('.swatch').forEach((s) => {
      s.classList.toggle('active', (s.dataset.color || '').toLowerCase() === norm);
    });
  }
  if (colorPicker) colorPicker.value = norm;
  if (hexInput && document.activeElement !== hexInput) hexInput.value = norm;
  const ro = document.getElementById('bgReadout');
  if (ro) ro.innerHTML = '<strong>' + presetNameFor(DARK_PRESETS, norm) + '</strong> <span>' + norm + '</span>';
  paintDocGrid();
  syncPreview();
}

function setDarkColor(color) {
  const norm = (color || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/i.test(norm)) return;
  chrome.storage.local.set({ docsDarkColor: norm });
  syncPaletteUI(norm);
}

if (paletteGrid) {
  paletteGrid.innerHTML = '';
  DARK_PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.color = p.color;
    b.dataset.label = p.label;
    b.title = `${p.label} (${p.color})`;
    b.style.background = p.color;
    const inner = document.createElement('span');
    inner.className = 'mini-sheet';
    b.appendChild(inner);
    const label = document.createElement('span');
    label.className = 'swatch-label';
    label.textContent = p.label;
    b.appendChild(label);
    b.addEventListener('click', () => setDarkColor(p.color));
    paletteGrid.appendChild(b);
  });
  paintThemeGrid();
}

if (colorPicker) {
  colorPicker.addEventListener('input', () => setDarkColor(colorPicker.value));
  colorPicker.addEventListener('change', () => setDarkColor(colorPicker.value));
}
if (hexInput) {
  hexInput.addEventListener('change', () => {
    let v = hexInput.value.trim().toLowerCase();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-f]{3}$/i.test(v)) {
      v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    }
    if (/^#[0-9a-f]{6}$/i.test(v)) setDarkColor(v);
    else syncPaletteUI(colorPicker ? colorPicker.value : DEFAULT_BG);
  });
  hexInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); hexInput.blur(); }
  });
}

// 6. Document palette (editor sheet — separate setting)
const docPaletteGrid = document.getElementById('docPaletteGrid');
const docColorPicker = document.getElementById('docColorPicker');
const docHexInput = document.getElementById('docHexInput');

function syncDocUI(activeColor) {
  const norm = (activeColor || DEFAULT_BG).toLowerCase();
  if (docPaletteGrid) {
    docPaletteGrid.querySelectorAll('.swatch').forEach((s) => {
      s.classList.toggle('active', (s.dataset.color || '').toLowerCase() === norm);
    });
  }
  if (docColorPicker) docColorPicker.value = norm;
  if (docHexInput && document.activeElement !== docHexInput) docHexInput.value = norm;
  const ro = document.getElementById('docReadout');
  if (ro) ro.innerHTML = '<strong>' + presetNameFor(DARK_PRESETS, norm) + '</strong> <span>' + norm + '</span>';
  paintThemeGrid();
  syncPreview();
}

function setDocColor(color) {
  const norm = (color || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/i.test(norm)) return;
  chrome.storage.local.set({ docsDocColor: norm });
  syncDocUI(norm);
}

if (docPaletteGrid) {
  docPaletteGrid.innerHTML = '';
  // Full palette — same 16 colors as the Page section.
  DARK_PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.color = p.color;
    b.dataset.label = p.label;
    b.title = `${p.label} (${p.color})`;
    b.style.background = p.color;
    const inner = document.createElement('span');
    inner.className = 'mini-sheet';
    b.appendChild(inner);
    const label = document.createElement('span');
    label.className = 'swatch-label';
    label.textContent = p.label;
    b.appendChild(label);
    b.addEventListener('click', () => setDocColor(p.color));
    docPaletteGrid.appendChild(b);
  });
  paintDocGrid();
}

if (docColorPicker) {
  docColorPicker.addEventListener('input', () => setDocColor(docColorPicker.value));
  docColorPicker.addEventListener('change', () => setDocColor(docColorPicker.value));
}
if (docHexInput) {
  docHexInput.addEventListener('change', () => {
    let v = docHexInput.value.trim().toLowerCase();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-f]{3}$/i.test(v)) {
      v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    }
    if (/^#[0-9a-f]{6}$/i.test(v)) setDocColor(v);
    else syncDocUI(docColorPicker ? docColorPicker.value : DEFAULT_BG);
  });
  docHexInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); docHexInput.blur(); }
  });
}

// 7. Text palette (main document text color)
const textPaletteGrid = document.getElementById('textPaletteGrid');
const textColorPicker = document.getElementById('textColorPicker');
const textHexInput = document.getElementById('textHexInput');

function syncTextUI(activeColor) {
  const norm = (activeColor || DEFAULT_TEXT).toLowerCase();
  if (textPaletteGrid) {
    textPaletteGrid.querySelectorAll('.swatch').forEach((s) => {
      s.classList.toggle('active', (s.dataset.color || '').toLowerCase() === norm);
    });
  }
  if (textColorPicker) textColorPicker.value = norm;
  if (textHexInput && document.activeElement !== textHexInput) textHexInput.value = norm;
  const ro = document.getElementById('textReadout');
  if (ro) ro.innerHTML = '<strong>' + presetNameFor(TEXT_PRESETS, norm) + '</strong> <span>' + norm + '</span>';
  syncPreview();
}

function setTextColor(color) {
  const norm = (color || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/i.test(norm)) return;
  chrome.storage.local.set({ docsTextColor: norm });
  syncTextUI(norm);
}

if (textPaletteGrid) {
  textPaletteGrid.innerHTML = '';
  // Contrast-first presets (light colors for dark sheets) + custom below.
  TEXT_PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.color = p.color;
    b.title = `${p.label} (${p.color})`;
    b.style.background = p.color;
    b.addEventListener('click', () => setTextColor(p.color));
    textPaletteGrid.appendChild(b);
  });
}

if (textColorPicker) {
  textColorPicker.addEventListener('input', () => setTextColor(textColorPicker.value));
  textColorPicker.addEventListener('change', () => setTextColor(textColorPicker.value));
}
if (textHexInput) {
  textHexInput.addEventListener('change', () => {
    let v = textHexInput.value.trim().toLowerCase();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-f]{3}$/i.test(v)) {
      v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    }
    if (/^#[0-9a-f]{6}$/i.test(v)) setTextColor(v);
    else syncTextUI(textColorPicker ? textColorPicker.value : DEFAULT_TEXT);
  });
  textHexInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); textHexInput.blur(); }
  });
}

// 8. Accent hue
const accentHueInput = document.getElementById('accentHue');
const hueValue = document.getElementById('hueValue');
const hueDot = document.getElementById('hueDot');

function syncHueUI(hue) {
  const h = Math.max(0, Math.min(360, Math.round(hue)));
  if (accentHueInput) accentHueInput.value = String(h);
  if (hueValue) hueValue.textContent = `${h}°`;
  if (hueDot) hueDot.style.background = `hsl(${h} 40% 60%)`;
  syncPreview();
}

if (accentHueInput) {
  accentHueInput.addEventListener('input', () => {
    const h = parseInt(accentHueInput.value, 10) || 0;
    syncHueUI(h);
    chrome.storage.local.set({ docsAccentHue: h });
  });
  accentHueInput.addEventListener('change', () => {
    chrome.storage.local.set({ docsAccentHue: parseInt(accentHueInput.value, 10) || 0 });
  });
}

// 9. Surfaces (Docs editor is always themed; Slides editor + PDF viewer
// stay light by design — no toggles for them)
const SURFACES = [
  { key: 'sheets', id: 'surfSheets' },
  { key: 'drive', id: 'surfDrive' },
  { key: 'docshome', id: 'surfHome' },
];
const SURF_DEFAULTS = { sheets: true, drive: true, docshome: true };

function readSurfaces(cb) {
  chrome.storage.local.get(['docsSurfaces'], (res) => {
    cb({ ...SURF_DEFAULTS, ...(res.docsSurfaces || {}) });
  });
}

function syncSurfacesUI(s) {
  SURFACES.forEach(({ key, id }) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.checked = s[key] !== false;
  });
}

readSurfaces(syncSurfacesUI);
SURFACES.forEach(({ key, id }) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', () => {
    readSurfaces((s) => {
      s[key] = el.checked;
      chrome.storage.local.set({ docsSurfaces: s });
    });
  });
});

// Edge hint — UA only. Feature flags themselves are invisible to extensions.
try {
  if (navigator.userAgent.includes('Edg/')) {
    const h = document.getElementById('edgeHint');
    if (h) h.style.display = 'block';
  }
} catch (_) {}

// 10. Activation drawer
const activateTrigger = document.getElementById('activateTrigger');
const activateBody = document.getElementById('activateBody');
const activateCaret = document.getElementById('activateCaret');

if (activateTrigger && activateBody) {
  activateTrigger.addEventListener('click', (e) => {
    e.preventDefault();
    const visible = activateBody.classList.toggle('visible');
    if (activateCaret) activateCaret.classList.toggle('open', visible);
  });
}

// 11. Activation (license key only)
const activateBtn = document.getElementById('activateBtn');
const licenseInput = document.getElementById('licenseInput');
const licenseError = document.getElementById('activateError');

async function handleActivation() {
  if (!licenseInput || !activateBtn) return;
  const rawValue = (licenseInput.value || '').trim().toUpperCase();
  if (!rawValue) return;

  activateBtn.textContent = 'Checking…';
  activateBtn.disabled = true;
  if (licenseError) licenseError.style.display = 'none';

  try {
    const res = await fetch(`${LICENSE_SERVER}/api/validate-license`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: rawValue })
    });
    const data = await res.json();
    if (data.valid) {
      await chrome.storage.local.set({
        prismPremium: true,
        prismLicenseKey: rawValue,
        prismUserEmail: data.email || '',
        prismLicenseValidatedAt: Date.now(),
        ...(data.currentPeriodEnd ? { prismLicenseExpiresAt: Date.parse(data.currentPeriodEnd) + LICENSE_GRACE_MS } : {})
      });
      if (licenseError) licenseError.style.display = 'none';
      activateBtn.textContent = 'Activated ✓';
      updateStatus();
      setTimeout(() => {
        activateBtn.textContent = 'Activate';
        activateBtn.disabled = false;
        if (activateBody) activateBody.classList.remove('visible');
        if (activateCaret) activateCaret.classList.remove('open');
      }, 1200);
    } else {
      if (licenseError) {
        licenseError.textContent = data.error || 'Invalid license key. Please check and retry.';
        licenseError.style.display = 'block';
      }
      activateBtn.textContent = 'Activate';
      activateBtn.disabled = false;
    }
  } catch (err) {
    if (licenseError) {
      licenseError.textContent = 'Unable to reach license server. Please check your connection.';
      licenseError.style.display = 'block';
    }
    activateBtn.textContent = 'Activate';
    activateBtn.disabled = false;
  }
}

if (activateBtn) activateBtn.addEventListener('click', handleActivation);
if (licenseInput) {
  licenseInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleActivation(); }
  });
}

// Initial sync + live updates
updateStatus();
syncDarkToggle();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.prismPremium || changes.prismLicenseExpiresAt || changes.prismInstallTime) { updateStatus(); refreshSearchUsage(); syncDarkToggle(); }
  if (changes.prismSearchCount || changes.prismSearchEnabled) refreshSearchUsage();
  if (changes.prismSearchEnabled && searchToggle) {
    searchToggle.checked = changes.prismSearchEnabled.newValue !== false;
    if (searchCard) searchCard.classList.toggle('disabled', changes.prismSearchEnabled.newValue === false);
  }
  if (changes.docsDarkColor) syncPaletteUI(changes.docsDarkColor.newValue || DEFAULT_BG);
  if (changes.docsDocColor) syncDocUI(changes.docsDocColor.newValue || DEFAULT_BG);
  if (changes.docsTextColor) syncTextUI(changes.docsTextColor.newValue || DEFAULT_TEXT);
  if (changes.docsDarkColor || changes.docsDocColor || changes.docsTextColor) {
    chrome.storage.local.get(['docsDarkColor', 'docsDocColor', 'docsTextColor'], (r) => {
      syncPresetUI({ bg: r.docsDarkColor || DEFAULT_BG, doc: r.docsDocColor || DEFAULT_BG, text: r.docsTextColor || DEFAULT_TEXT });
    });
  }
  if (changes.docsDarkMode || changes.prismPremium || changes.prismLicenseExpiresAt || changes.prismInstallTime) syncDarkToggle();
  if (changes.docsAccentHue) syncHueUI(Number.isFinite(+changes.docsAccentHue.newValue) ? +changes.docsAccentHue.newValue : 225);
  if (changes.docsShowBorder && borderToggle) borderToggle.checked = changes.docsShowBorder.newValue !== false;
  if (changes.docsShowQuickToggle && quickToggleVisible) quickToggleVisible.checked = changes.docsShowQuickToggle.newValue !== false;
  if (changes.docsSurfaces) readSurfaces(syncSurfacesUI);
});
