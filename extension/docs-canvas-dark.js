// Prism — Google Docs Canvas Dark Mode Engine v2
// Runs in the webpage context (world: "MAIN") at document_start.
// Intercepts CanvasRenderingContext2D drawing methods to provide native-quality
// dark mode: recoloring text & page backgrounds while leaving images 100% untouched
// (unless the user explicitly opts into image inversion).

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__PRISM_CANVAS_DARK_INSTALLED__) return;
  window.__PRISM_CANVAS_DARK_INSTALLED__ = true;

  // ── Settings (updated by attribute/event observers) ─────────────────────────
  // NOTE: document.documentElement can be null when this runs at document_start.
  // A throw here kills the entire engine, leaving CSS-only behavior behind:
  // dark chrome, white pages, working invert filter. So all DOM reads below
  // are null-safe, and settings sync is retried once the DOM exists.
  let isDarkMode = false;
  // Opt-in instant mode (brief scroll jump). Default off per user request.
  let instantRepaint = false;
  // Host app: docs | sheets (grid mode) — set via data-prism-app.
  let app = 'docs';
  // Custom dark color (hex, synced via data-prism-dark-color)
  let darkBgColor = '#1a1a1a';
  let darkBodyColor = lightenHex(darkBgColor, -14); // slightly darker for outer body
  // Main text color (user setting). Neutral dark text maps to this; the rgb
  // split feeds the alpha-preserving variant below.
  let textColor = '#e2e8f0';
  let textRgb = { r: 226, g: 232, b: 240 };
  function syncTextColor(hex) {
    const clean = (typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex.trim())) ? hex.trim().toLowerCase() : '#e2e8f0';
    textColor = clean;
    try { textRgb = hexToRgb(clean); } catch (_) { textRgb = { r: 226, g: 232, b: 240 }; }
  }

  function syncSettingsFromDom() {
    const root = document.documentElement;
    if (!root) return false;
    isDarkMode = root.getAttribute('data-prism-dark') === 'true';
    instantRepaint = root.getAttribute('data-prism-instant') === 'true';
    app = root.getAttribute('data-prism-app') || 'docs';
    // Document editor sheet color (separate from the outer page color).
    darkBgColor = root.getAttribute('data-prism-doc-color')
      || root.getAttribute('data-prism-dark-color') || '#1a1a1a';
    darkBodyColor = lightenHex(darkBgColor, -14);
    syncTextColor(root.getAttribute('data-prism-text-color') || '#e2e8f0');
    return true;
  }

  syncSettingsFromDom();

  // Cache color transformations to ensure 60fps rendering without GC overhead
  const textTransformCache = new Map();
  const bgTransformCache = new Map();
  const lineTransformCache = new Map();
  const MAX_CACHE_SIZE = 600;

  // ── Color Utilities ──────────────────────────────────────────────────────────

  function hexToRgb(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const n = parseInt(hex, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function lightenHex(hex, amount) {
    const { r, g, b } = hexToRgb(hex);
    const clamp = v => Math.max(0, Math.min(255, v));
    return `rgb(${clamp(r + amount)}, ${clamp(g + amount)}, ${clamp(b + amount)})`;
  }

  /**
   * Fast color parser supporting:
   * - #hex (3, 4, 6, 8 digits)
   * - rgb() and rgba()
   * - Named colors (black, white, transparent)
   */
  function parseColor(colorStr) {
    if (typeof colorStr !== 'string') return null;
    const s = colorStr.trim().toLowerCase();

    // Fast path: hex colors
    if (s.charCodeAt(0) === 35 /* '#' */) {
      if (s.length === 7) {
        const num = parseInt(s.slice(1), 16);
        return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255, a: 1 };
      }
      if (s.length === 4) {
        const r = parseInt(s[1] + s[1], 16);
        const g = parseInt(s[2] + s[2], 16);
        const b = parseInt(s[3] + s[3], 16);
        return { r, g, b, a: 1 };
      }
      if (s.length === 9) {
        const num = parseInt(s.slice(1, 7), 16);
        const alpha = parseInt(s.slice(7), 16) / 255;
        return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255, a: alpha };
      }
    }

    // Fast path: rgb/rgba
    if (s.startsWith('rgb')) {
      const match = s.match(/\(([^)]+)\)/);
      if (match) {
        const parts = match[1].split(/[\s,/]+/).filter(Boolean);
        if (parts.length >= 3) {
          const r = parseFloat(parts[0]);
          const g = parseFloat(parts[1]);
          const b = parseFloat(parts[2]);
          const a = parts[3] !== undefined ? parseFloat(parts[3]) : 1;
          return { r, g, b, a: isNaN(a) ? 1 : a };
        }
      }
    }

    // Common named colors
    if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
    if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

    return null;
  }

  /** ITU-R BT.601 perceived luminance */
  function luminance(r, g, b) {
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  // ── Text Color Transform ─────────────────────────────────────────────────────

  /**
   * Transforms text fillStyle for dark mode:
   * - Dark/off-black colors (luminance < 0.38) → crisp off-white
   * - Dark saturated colors → brightened to preserve hue
   * - Already bright colors → kept untouched
   */
  function transformTextColor(originalStyle) {
    if (typeof originalStyle !== 'string') return originalStyle;

    const cached = textTransformCache.get(originalStyle);
    if (cached !== undefined) return cached;

    const parsed = parseColor(originalStyle);
    if (!parsed || parsed.a === 0) {
      cacheSet(textTransformCache, originalStyle, originalStyle);
      return originalStyle;
    }

    const lum = luminance(parsed.r, parsed.g, parsed.b);
    let result = originalStyle;

    if (lum < 0.38) {
      const diffRG = Math.abs(parsed.r - parsed.g);
      const diffGB = Math.abs(parsed.g - parsed.b);
      const diffRB = Math.abs(parsed.r - parsed.b);
      const isNeutral = (diffRG < 18 && diffGB < 18 && diffRB < 18);

      if (isNeutral) {
        // Neutral dark text → user text color (alpha preserved)
        result = parsed.a < 1 ? `rgba(${textRgb.r}, ${textRgb.g}, ${textRgb.b}, ${parsed.a})` : textColor;
      } else {
        // Boost lightness while preserving hue for dark saturated text.
        // Never dim: vivid colors (bright reds/oranges) pass through as-is.
        const max = Math.max(parsed.r, parsed.g, parsed.b);
        const scale = max > 0 && max < 210 ? (210 / max) : 1;
        const newR = Math.min(255, Math.round(parsed.r * scale));
        const newG = Math.min(255, Math.round(parsed.g * scale));
        const newB = Math.min(255, Math.round(parsed.b * scale));
        result = parsed.a < 1 ? `rgba(${newR}, ${newG}, ${newB}, ${parsed.a})` : `rgb(${newR}, ${newG}, ${newB})`;
      }
    }

    cacheSet(textTransformCache, originalStyle, result);
    return result;
  }

  // ── Background Color Transform ───────────────────────────────────────────────

  /**
   * Transforms large background fills (fillRect):
   * - White or near-white fills (luminance > 0.88) → custom dark bg color
   * - Very dark fills that might be table cell borders → keep as-is or lighten
   */
  function transformBgColor(originalStyle) {
    if (typeof originalStyle !== 'string') return originalStyle;

    const cached = bgTransformCache.get(originalStyle);
    if (cached !== undefined) return cached;

    const parsed = parseColor(originalStyle);
    if (!parsed) {
      cacheSet(bgTransformCache, originalStyle, originalStyle);
      return originalStyle;
    }

    const lum = luminance(parsed.r, parsed.g, parsed.b);
    let result = originalStyle;

    if (lum > 0.88) {
      // Light/white background → dark page color
      const bg = hexToRgb(darkBgColor);
      result = parsed.a < 1 ? `rgba(${bg.r}, ${bg.g}, ${bg.b}, ${parsed.a})` : darkBgColor;
    }

    cacheSet(bgTransformCache, originalStyle, result);
    return result;
  }

  // ── Line/Stroke Color Transform (Table Borders) ──────────────────────────────

  /**
   * Transforms stroke colors for lines & table borders:
   * - Black/very dark strokes → light gray/white so table borders are visible
   * - Already light strokes → pass through
   */
  function transformLineColor(originalStyle) {
    if (typeof originalStyle !== 'string') return originalStyle;

    const cached = lineTransformCache.get(originalStyle);
    if (cached !== undefined) return cached;

    const parsed = parseColor(originalStyle);
    if (!parsed || parsed.a === 0) {
      cacheSet(lineTransformCache, originalStyle, originalStyle);
      return originalStyle;
    }

    const lum = luminance(parsed.r, parsed.g, parsed.b);
    let result = originalStyle;

    if (app === 'sheets') {
      // Sheets grid mode: neutral cell borders AND light-gray gridlines all go
      // white so the grid stays crisp on dark cells. Colored borders keep hue.
      const mx = Math.max(parsed.r, parsed.g, parsed.b);
      const mn = Math.min(parsed.r, parsed.g, parsed.b);
      if (mx - mn < 30) {
        result = parsed.a < 1 ? `rgba(232, 234, 237, ${parsed.a})` : '#e8eaed';
      }
    } else if (lum < 0.25) {
      // Dark/black borders → white so table borders stay visible on dark bg
      result = parsed.a < 1 ? `rgba(232, 234, 237, ${parsed.a})` : '#e8eaed';
    }

    cacheSet(lineTransformCache, originalStyle, result);
    return result;
  }

  function cacheSet(map, key, value) {
    if (map.size > MAX_CACHE_SIZE) map.clear();
    map.set(key, value);
  }

  // ── Canvas API Patches ───────────────────────────────────────────────────────
  // Patched on BOTH the main-thread and offscreen (worker) 2D contexts, since
  // page tiles may rasterize off the main thread on a separate prototype.

  const stats = { text: 0, bg: 0, line: 0, image: 0 };

  function patchProto(proto) {
    if (!proto || proto.__prismPatched) return;
    proto.__prismPatched = true;

    const origFillText = proto.fillText;
    const origStrokeText = proto.strokeText;
    const origFillRect = proto.fillRect;
    const origFill = proto.fill;
    const origStroke = proto.stroke;
    const origStrokeRect = proto.strokeRect;
    const origDrawImage = proto.drawImage;

    // 1. Text rendering interception
    proto.fillText = function (text, x, y, maxWidth) {
      if (isDarkMode && this.fillStyle) {
        const prev = this.fillStyle;
        const next = transformTextColor(prev);
        if (next !== prev) stats.text++;
        this.fillStyle = next;
        if (maxWidth !== undefined) origFillText.call(this, text, x, y, maxWidth);
        else origFillText.call(this, text, x, y);
        this.fillStyle = prev;
        return;
      }
      return maxWidth !== undefined
        ? origFillText.call(this, text, x, y, maxWidth)
        : origFillText.call(this, text, x, y);
    };

    proto.strokeText = function (text, x, y, maxWidth) {
      if (isDarkMode && this.strokeStyle) {
        const prev = this.strokeStyle;
        const next = transformTextColor(prev);
        if (next !== prev) stats.text++;
        this.strokeStyle = next;
        if (maxWidth !== undefined) origStrokeText.call(this, text, x, y, maxWidth);
        else origStrokeText.call(this, text, x, y);
        this.strokeStyle = prev;
        return;
      }
      return maxWidth !== undefined
        ? origStrokeText.call(this, text, x, y, maxWidth)
        : origStrokeText.call(this, text, x, y);
    };

    // 2a. Background rect fills (page surface / sheet cells)
    proto.fillRect = function (x, y, w, h) {
      // Docs: only large rects are page surfaces (protects small content).
      // Sheets: every cell paints its own small rect, so the size guard is
      // lifted — photos still safe (they arrive via drawImage, not fillRect),
      // and only near-white fills are remapped.
      const isSheetCell = app === 'sheets';
      if (isDarkMode && this.fillStyle && (isSheetCell || (w > 60 && h > 60))) {
        const prev = this.fillStyle;
        const next = transformBgColor(prev);
        if (next !== prev) stats.bg++;
        this.fillStyle = next;
        origFillRect.call(this, x, y, w, h);
        this.fillStyle = prev;
        return;
      }
      return origFillRect.call(this, x, y, w, h);
    };

    // 2b. Path-based page backgrounds (rect() + fill()). Only near-white fills
    // are remapped, so colored shapes, highlights and drawings pass through.
    proto.fill = function (...args) {
      if (isDarkMode && this.fillStyle) {
        const prev = this.fillStyle;
        const next = transformBgColor(prev);
        if (next !== prev) {
          stats.bg++;
          this.fillStyle = next;
          origFill.apply(this, args);
          this.fillStyle = prev;
          return;
        }
      }
      return origFill.apply(this, args);
    };

    // 3. Stroke (table borders / lines)
    proto.stroke = function (...args) {
      if (isDarkMode && this.strokeStyle) {
        const prev = this.strokeStyle;
        const next = transformLineColor(prev);
        if (next !== prev) stats.line++;
        this.strokeStyle = next;
        origStroke.apply(this, args);
        this.strokeStyle = prev;
        return;
      }
      return origStroke.apply(this, args);
    };

    proto.strokeRect = function (x, y, w, h) {
      if (isDarkMode && this.strokeStyle) {
        const prev = this.strokeStyle;
        const next = transformLineColor(prev);
        if (next !== prev) stats.line++;
        this.strokeStyle = next;
        origStrokeRect.call(this, x, y, w, h);
        this.strokeStyle = prev;
        return;
      }
      return origStrokeRect.call(this, x, y, w, h);
    };

    // 4. Images always pass through untouched — there is no inversion
    // feature. Photos, charts and drawings keep their native colors.
    proto.drawImage = function (...args) {
      return origDrawImage.apply(this, args);
    };
  }

  if (typeof CanvasRenderingContext2D !== 'undefined') patchProto(CanvasRenderingContext2D.prototype);
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') patchProto(OffscreenCanvasRenderingContext2D.prototype);

  // ── Dynamic Toggle & Repaint ─────────────────────────────────────────────────

  function clearCaches() {
    textTransformCache.clear();
    bgTransformCache.clear();
    lineTransformCache.clear();
  }

  // Find the REAL scroll container: the scrollable ancestor with the largest
  // scroll range among the tile canvas lineage (Sheets scrolls a grid
  // container, Docs scrolls the editor scroller — never assume class names).
  // Returns { el, range } or null when nothing scrolls (short doc).
  function findScroller() {
    try {
      const seen = new Set();
      const found = [];
      const consider = (el) => {
        if (!el || seen.has(el)) return;
        seen.add(el);
        let range = 0;
        try { range = Math.max(0, el.scrollHeight - el.clientHeight); } catch (_) {}
        if (range > 0) found.push({ el, range });
      };
      let biggest = null;
      let area = 0;
      try {
        document.querySelectorAll('canvas').forEach((c) => {
          try {
            const a = (c.width || 0) * (c.height || 0);
            if (a > area) { area = a; biggest = c; }
          } catch (_) {}
        });
      } catch (_) {}
      const climb = (start) => {
        let el = start && start.parentElement;
        let depth = 0;
        while (el && el !== document.body && el !== document.documentElement && depth < 14) {
          consider(el);
          el = el.parentElement;
          depth++;
        }
      };
      if (biggest) climb(biggest);
      try {
        const page = document.querySelector('.kix-page, .kix-page-paginated');
        if (page) climb(page);
      } catch (_) {}
      ['.kix-appview-editor', '#docs-editor-container', '#docs-editor'].forEach((sel) => {
        try { document.querySelectorAll(sel).forEach(consider); } catch (_) {}
      });
      try { consider(document.scrollingElement); } catch (_) {}
      found.sort((a, b) => b.range - a.range);
      return found.length ? found[0] : null;
    } catch (_) { return null; }
  }

  let repaintTimer = 0;
  let repaintWantScroll = false;
  // Set when a sheet-relevant change lands while the tab is hidden — canvas
  // tiles cannot re-rasterize until the tab is visible again (see observer).
  let pendingRepaintWhileHidden = false;
  function scheduleRepaint(opts) {
    // Coalesce rapid slider drags into a single repaint.
    if (opts && opts.scroll) repaintWantScroll = true;
    try {
      // A blurred/hidden tab defers tile rasterization, so anything scheduled
      // now may never paint — flag it for replay on focus/visible.
      if (typeof document !== 'undefined' && document.hidden && repaintWantScroll) {
        pendingRepaintWhileHidden = true;
      }
    } catch (_) {}
    try { clearTimeout(repaintTimer); } catch (_) {}
    repaintTimer = setTimeout(() => {
      const wantScroll = repaintWantScroll;
      repaintWantScroll = false;
      try { triggerRepaint(wantScroll); } catch (_) {}
    }, 350);
  }

  function triggerRepaint(wantScroll) {
    clearCaches();
    // Docs/Sheets redraw is requested by content-doc.js through the native
    // app-switcher controls. Do not zoom, scroll, resize, or pad the page.
    writeHeartbeat();
  }

  let pulseRunning = false;
  let pulseQueued = false;
  function pulseZoomThenScroll() {
    // Ordered, aggressive and fast: ZOOM first (forces Docs to relayout and
    // re-rasterize tiles), THEN a verified full-viewport scroll jump, then
    // restore both. The whole sequence runs in well under a second, so the
    // sheet follows color picks with no click. Overlapping requests coalesce
    // into one trailing pulse.
    try {
      if (typeof document === 'undefined' || !document.documentElement) return;
      if (document.hidden) { pendingRepaintWhileHidden = true; return; }
      if (pulseRunning) { pulseQueued = true; return; }
      pulseRunning = true;
      pulseQueued = false;
      const root = document.documentElement;
      const prevZoom = root.style.zoom || '';
      let scEl = null;
      let scY = 0;
      let scTo = 0;
      let scVh = 800;
      // 1) ZOOM — strong enough that Docs must relayout and re-rasterize.
      try {
        root.style.zoom = '1.12';
        void root.offsetHeight;
      } catch (_) {}
      setTimeout(() => {
        // 2) SCROLL — verified full-viewport jump while zoomed.
        try {
          const found = findScroller();
          if (found && found.el && found.range >= 200) {
            scEl = found.el;
            try { scY = scEl.scrollTop || 0; } catch (_) { scY = 0; }
            try { scVh = scEl.clientHeight || window.innerHeight || 800; } catch (_) {}
            const step = Math.max(scVh, 600);
            scTo = scY + step;
            if (scTo > found.range) scTo = Math.max(0, scY - step);
            if (Math.abs(scTo - scY) >= 40) {
              try { scEl.scrollTop = scTo; } catch (_) { scEl = null; }
            } else { scEl = null; }
          }
        } catch (_) { scEl = null; }
        setTimeout(() => {
          // 3) RESTORE zoom, then scroll position.
          try {
            if (root.style.zoom === '1.12') root.style.zoom = prevZoom;
            void root.offsetHeight;
          } catch (_) {}
          try {
            if (scEl && Math.abs(scEl.scrollTop - scTo) < scVh) scEl.scrollTop = scY;
          } catch (_) {}
          try { window.dispatchEvent(new Event('resize')); } catch (_) {}
          writeHeartbeat();
          pulseRunning = false;
          if (pulseQueued) { pulseQueued = false; scheduleRepaint({ scroll: true }); }
        }, 350);
      }, 200);
    } catch (_) {
      try { pulseRunning = false; } catch (_) {}
    }
  }

  function nudgeZoom() {
    try {
      const root = document.documentElement;
      if (!root) return;
      // Guard against overlapping nudges; the dwell is deliberately long —
      // Docs rasterizes tiles asynchronously, and restoring too early
      // reverts the relayout before fresh tiles are ever painted.
      if (root.dataset.prismZoom === '1') return;
      root.dataset.prismZoom = '1';
      const prev = root.style.zoom || '';
      root.style.zoom = '1.005';
      void root.offsetHeight;
      setTimeout(() => {
        try {
          if (root.dataset.prismZoom === '1') {
            if (root.style.zoom === '1.005') root.style.zoom = prev;
            void root.offsetHeight;
          }
          delete root.dataset.prismZoom;
        } catch (_) {}
        try { window.dispatchEvent(new Event('resize')); } catch (_) {}
        writeHeartbeat();
      }, 650);
    } catch (_) {}
  }

  function nudgeSize() {
    try {
      const target = document.querySelector('#docs-editor-container')
        || document.querySelector('.kix-appview-editor')
        || document.body;
      if (!target) return;
      if (target.dataset && target.dataset.prismPad === '1') return;
      if (target.dataset) target.dataset.prismPad = '1';
      const prev = target.style.paddingTop || '';
      target.style.paddingTop = '1px';
      void target.offsetHeight;
      setTimeout(() => {
        try {
          if (target.style.paddingTop === '1px') target.style.paddingTop = prev;
          void target.offsetHeight;
        } catch (_) {}
        try { if (target.dataset) delete target.dataset.prismPad; } catch (_) {}
      }, 600);
    } catch (_) {}
  }

  // (The zoom-then-scroll pulse above is the only scroll lever; there is no
  // separate excursion path — overlapping pulses coalesce via pulseQueued.)

  // Observe attribute changes on <html>
  // NOTE: canvas tiles cannot re-rasterize while the tab is hidden (the
  // popup writes colors while Docs sits in the background), so a repaint
  // scheduled while hidden has no visible effect. Flag it and replay the
  // repaint as soon as the tab becomes visible/focused again.
  const observer = new MutationObserver(() => {
    const wasDark = isDarkMode;
    const darkActive = document.documentElement.getAttribute('data-prism-dark') === 'true';
    const newBgColor = document.documentElement.getAttribute('data-prism-doc-color')
      || document.documentElement.getAttribute('data-prism-dark-color') || '#1a1a1a';

    let changed = false;
    // Only sheet-relevant changes need the scroll pulse; the accent hue is
    // CSS-only (links/cursor) and must never move the page.
    let canvasChanged = false;
    if (darkActive !== isDarkMode) { isDarkMode = darkActive; changed = true; canvasChanged = true; }
    const newApp = document.documentElement.getAttribute('data-prism-app') || 'docs';
    if (newApp !== app) { app = newApp; changed = true; canvasChanged = true; }
    if (newBgColor !== darkBgColor) {
      darkBgColor = newBgColor;
      darkBodyColor = lightenHex(darkBgColor, -14);
      changed = true;
      canvasChanged = true;
    }
    const newText = document.documentElement.getAttribute('data-prism-text-color') || '#e2e8f0';
    if (newText.toLowerCase() !== textColor) { syncTextColor(newText); changed = true; canvasChanged = true; }
    // Instant flag is not a visual change — sync silently, no repaint.
    instantRepaint = document.documentElement.getAttribute('data-prism-instant') === 'true';
    // Canvas only paints while dark (on, or just switched off) — skip the
    // scroll pulse entirely when staying in light mode.
    if (changed && (darkActive || wasDark)) {
      if (canvasChanged) scheduleRepaint({ scroll: true });
      else scheduleRepaint();
    }
    else if (changed) { clearCaches(); writeHeartbeat(); }
  });

  function startObserving() {
    const root = document.documentElement;
    if (!root) return false;
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-prism-dark', 'data-prism-app', 'data-prism-doc-color', 'data-prism-dark-color', 'data-prism-text-color', 'data-prism-instant']
    });
    return true;
  }

  if (!startObserving()) {
    // DOM not ready yet at document_start — retry once parsing reaches <html>.
    document.addEventListener('DOMContentLoaded', () => {
      syncSettingsFromDom();
      startObserving();
      triggerRepaint();
    }, { once: true });
  }

  // Replay any color change that landed while the tab was hidden (see above).
  function flushPendingRepaint() {
    try {
      if (pendingRepaintWhileHidden && typeof document !== 'undefined' && !document.hidden) {
        pendingRepaintWhileHidden = false;
        triggerRepaint(true);
      }
    } catch (_) {}
  }
  try {
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', flushPendingRepaint);
      window.addEventListener('focus', flushPendingRepaint);
    }
  } catch (_) {}

  // Also listen for custom events from content script
  window.addEventListener('prism-dark-toggle', (event) => {
    if (event.detail && typeof event.detail.enabled === 'boolean') {
      const wasDarkEv = isDarkMode;
      isDarkMode = event.detail.enabled;
      let canvasChangedEv = wasDarkEv !== isDarkMode;
      if (typeof event.detail.app === 'string' && event.detail.app !== app) {
        app = event.detail.app;
        canvasChangedEv = true;
      }
      if (event.detail.docColor) {
        if (event.detail.docColor !== darkBgColor) canvasChangedEv = true;
        darkBgColor = event.detail.docColor;
        darkBodyColor = lightenHex(darkBgColor, -14);
      } else if (event.detail.darkColor) {
        if (event.detail.darkColor !== darkBgColor) canvasChangedEv = true;
        darkBgColor = event.detail.darkColor;
        darkBodyColor = lightenHex(darkBgColor, -14);
      }
      if (event.detail.textColor) {
        if (String(event.detail.textColor).toLowerCase() !== textColor) canvasChangedEv = true;
        syncTextColor(event.detail.textColor);
      }
      // A popup toggle can leave Docs blurred without making it hidden. Run
      // the invalidation immediately in that case; waiting for focus/resize
      // leaves the already-rasterized page canvas unchanged.
      if (canvasChangedEv && (isDarkMode || wasDarkEv) && !document.hidden) triggerRepaint(true);
      else if (canvasChangedEv && (isDarkMode || wasDarkEv)) scheduleRepaint({ scroll: true });
      else scheduleRepaint();
    }
  });

  // Heartbeat: publish liveness + hit counters as DOM attributes. The isolated
  // content script can't see MAIN-world JS state, so it relays these to
  // storage for the popup's engine status line.
  function writeHeartbeat() {
    try {
      const root = document.documentElement;
      if (!root) return;
      root.setAttribute('data-prism-engine', 'v8');
      root.setAttribute('data-prism-engine-hits', `${stats.text}.${stats.bg}.${stats.line}.${stats.image}`);
    } catch (_) {}
  }
  setInterval(() => { if (isDarkMode) writeHeartbeat(); }, 2000);

  // Debug/verification handle (MAIN world). In the Docs tab console, run:
  //   __PRISM_CANVAS_DARK__.stats    — non-zero text/bg proves interception
  //   __PRISM_CANVAS_DARK__.repaint() — force a repaint on demand
  window.__PRISM_CANVAS_DARK__ = {
    version: 8,
    get dark() { return isDarkMode; },
    get app() { return app; },
    get bg() { return darkBgColor; },
    repaint: function () { try { triggerRepaint(true); return true; } catch (_) { return false; } },
    get offscreenPatched() {
      return (typeof OffscreenCanvasRenderingContext2D !== 'undefined') &&
        !!OffscreenCanvasRenderingContext2D.prototype.__prismPatched;
    },
    stats,
  };

})();
