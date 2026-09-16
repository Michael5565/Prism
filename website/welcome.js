// Prism Welcome Page Preview Engine

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSearchPreview();
  initThemePreview();
  ensureDriveLinks();
});

function ensureDriveLinks() {
  // Guarantee all drive buttons reliably open drive.google.com in a new tab
  const driveButtons = document.querySelectorAll('a[href="https://drive.google.com"]');
  driveButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      // Allow default navigation, but also ensure window.open fallback if needed
      if (!e.defaultPrevented) {
        window.open('https://drive.google.com', '_blank');
        e.preventDefault();
      }
    });
  });
}

function initTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  const contents = document.querySelectorAll('.tab-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetId = tab.getAttribute('data-tab');
      tabs.forEach(t => t.classList.remove('active'));
      contents.forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      const targetEl = document.getElementById(targetId);
      if (targetEl) targetEl.classList.add('active');
    });
  });
}

const mockDocuments = [
  {
    title: "Q4 2026 Executive Financial Review.docx",
    type: "Google Doc",
    tagClass: "tag-doc",
    body: "Overall quarterly revenue projections reflect strong retention across enterprise accounts with 18% ARR growth.",
    matches: {
      "revenue": "...Overall quarterly <mark>revenue projections</mark> reflect strong retention across enterprise accounts...",
      "projections": "...Overall quarterly revenue <mark>projections</mark> reflect strong retention...",
      "roadmap": "...Milestones align directly with the 2026 product <mark>roadmap</mark>...",
      "termination": "...standard mutual 30-day <mark>termination</mark> notice applies...",
      "audit": "...passed external SOC-2 <mark>audit</mark> without exceptions..."
    }
  },
  {
    title: "Enterprise Master Services Agreement.pdf",
    type: "PDF Document",
    tagClass: "tag-pdf",
    body: "Section 14.2: Either party may enact agreement termination for convenience upon sixty (60) days prior written notice.",
    matches: {
      "termination": "...Section 14.2: Either party may enact agreement <mark>termination</mark> for convenience upon sixty (60) days prior written notice...",
      "revenue": "...billing schedules aligned to audited gross <mark>revenue</mark> targets...",
      "audit": "...Client reserves the right to conduct an annual security <mark>audit</mark>..."
    }
  },
  {
    title: "Product Strategy & 2026 Roadmap.gslides",
    type: "Google Slides",
    tagClass: "tag-sheet",
    body: "Slide 8: The product roadmap prioritizes sub-second search indexing and native dark mode for Docs.",
    matches: {
      "roadmap": "...Slide 8: The product <mark>roadmap</mark> prioritizes sub-second search indexing and native dark mode...",
      "revenue": "...Key monetization drivers impacting recurring <mark>revenue</mark>...",
      "audit": "...Compliance and accessibility <mark>audit</mark> scheduled for Q3..."
    }
  }
];

function initSearchPreview() {
  const input = document.getElementById('preview-search-input');
  const list = document.getElementById('preview-results-list');
  const chips = document.querySelectorAll('.chip');

  if (!input || !list) return;

  function renderSearch(query) {
    const q = (query || '').trim().toLowerCase();
    list.innerHTML = '';

    if (!q) {
      list.innerHTML = '<div style="color: var(--muted); font-size: 13px; padding: 12px 0;">Type a keyword to test search matching.</div>';
      return;
    }

    const filtered = mockDocuments.filter(doc => {
      const inTitle = doc.title.toLowerCase().includes(q);
      const inBody = doc.body.toLowerCase().includes(q);
      const inMatches = Object.keys(doc.matches).some(k => q.includes(k) || k.includes(q));
      return inTitle || inBody || inMatches;
    });

    if (filtered.length === 0) {
      list.innerHTML = `<div style="color: var(--muted); font-size: 13px; padding: 14px 0;">No matching passages found for "${escapeHtml(query)}". Try "revenue", "roadmap", or "termination".</div>`;
      return;
    }

    filtered.forEach(doc => {
      let snippet = doc.body;
      for (const k in doc.matches) {
        if (q.includes(k) || k.includes(q)) {
          snippet = doc.matches[k];
          break;
        }
      }

      const card = document.createElement('div');
      card.className = 'result-card';
      card.innerHTML = `
        <div class="result-top">
          <div>
            <span class="file-type-tag ${doc.tagClass}">${doc.type}</span>
            <strong style="color: var(--text);">${escapeHtml(doc.title)}</strong>
          </div>
          <span style="color: var(--lime); font-size: 12px; font-family: monospace;">1 match</span>
        </div>
        <div class="result-snippet">${snippet}</div>
        <div class="jump-action">
          <span style="font-size: 11px; color: var(--faint);">Paragraph 12 · 98% confidence</span>
          <button class="jump-btn" type="button">Jump to match in Doc ↗</button>
        </div>
      `;

      card.querySelector('.jump-btn').addEventListener('click', () => {
        window.open('https://drive.google.com', '_blank');
      });

      list.appendChild(card);
    });
  }

  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      const query = chip.getAttribute('data-query');
      input.value = query;
      renderSearch(query);
    });
  });

  input.addEventListener('input', (e) => {
    renderSearch(e.target.value);
  });

  renderSearch(input.value || 'revenue');
}

function initThemePreview() {
  const btns = document.querySelectorAll('.theme-pill-btn');
  const preview = document.getElementById('doc-preview-canvas');
  const label = document.getElementById('current-theme-label');

  if (!btns.length || !preview) return;

  const names = {
    midnight: "Midnight Obsidian",
    oled: "OLED Pure Black",
    slate: "Nordic Slate",
    light: "Standard Light"
  };

  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const theme = btn.getAttribute('data-theme');
      preview.setAttribute('data-theme', theme);
      if (label) label.textContent = names[theme] || theme;
    });
  });
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[m]);
}
