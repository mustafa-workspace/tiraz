/* ===================================================
   TIRAZ Content Script
   Activate: hold Ctrl and click any element
   Toggle inspect mode: Ctrl+Shift+F
   =================================================== */

(function () {
  'use strict';

  // Prevent double injection
  if (window.__TIRAZLoaded) return;
  window.__TIRAZLoaded = true;

  // ─── State ────────────────────────────────────────
  let inspectModeActive = false;
  let panelVisible = false;
  let isDragging = false;
  let dragOffsetX = 0, dragOffsetY = 0;
  let currentTab = 'computed';
  let currentElement = null;
  let allProperties = [];
  let searchQuery = '';
  let collapsedGroups = new Set();

  // ─── CSS Property Groups ──────────────────────────
  const GROUPS = [
    {
      id: 'layout',
      label: 'Layout',
      color: '#63b3ed',
      props: ['display', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
        'float', 'clear', 'overflow', 'overflow-x', 'overflow-y', 'visibility']
    },
    {
      id: 'flexbox',
      label: 'Flexbox & Grid',
      color: '#9f7aea',
      props: ['flex', 'flex-direction', 'flex-wrap', 'flex-flow', 'justify-content',
        'align-items', 'align-content', 'align-self', 'flex-grow', 'flex-shrink',
        'flex-basis', 'order', 'gap', 'row-gap', 'column-gap',
        'grid', 'grid-template', 'grid-template-columns', 'grid-template-rows',
        'grid-template-areas', 'grid-column', 'grid-row', 'grid-area',
        'place-items', 'place-content', 'place-self']
    },
    {
      id: 'box',
      label: 'Box Model',
      color: '#f6ad55',
      props: ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
        'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
        'border-radius', 'border-color', 'border-width', 'border-style',
        'box-sizing', 'box-shadow']
    },
    {
      id: 'typography',
      label: 'Typography',
      color: '#68d391',
      props: ['font', 'font-family', 'font-size', 'font-weight', 'font-style',
        'font-variant', 'line-height', 'letter-spacing', 'word-spacing',
        'text-align', 'text-decoration', 'text-transform', 'text-shadow',
        'text-overflow', 'white-space', 'word-break', 'color']
    },
    {
      id: 'visual',
      label: 'Visual & Effects',
      color: '#fc8181',
      props: ['background', 'background-color', 'background-image', 'background-size',
        'background-position', 'background-repeat', 'background-attachment',
        'opacity', 'filter', 'backdrop-filter', 'mix-blend-mode', 'isolation',
        'clip-path', 'mask', 'cursor']
    },
    {
      id: 'animation',
      label: 'Animation & Transform',
      color: '#76e4f7',
      props: ['transform', 'transform-origin', 'transition', 'animation',
        'animation-name', 'animation-duration', 'animation-timing-function',
        'animation-delay', 'animation-iteration-count', 'animation-direction',
        'animation-fill-mode', 'will-change']
    }
  ];

  // ─── Utility: get CSS selector for element ────────
  function getSelector(el) {
    if (!el || el === document.body) return 'body';
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = el.classList.length
      ? '.' + Array.from(el.classList).slice(0, 2).join('.')
      : '';
    return tag + id + cls;
  }

  // ─── Utility: detect color values ─────────────────
  function isColorValue(val) {
    return /^(#|rgb|rgba|hsl|hsla|oklch|color\(|transparent|currentColor)/i.test(val.trim())
      || ['white', 'black', 'red', 'blue', 'green', 'yellow', 'orange', 'purple',
        'pink', 'gray', 'grey', 'navy', 'teal', 'lime', 'cyan', 'magenta', 'silver',
        'gold', 'indigo', 'violet', 'brown', 'coral', 'salmon', 'khaki', 'turquoise'].includes(val.trim().toLowerCase());
  }

  function escapeHtml(value = '') {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function applySmoothPreview(el) {
    if (!el) return;

    const previousTransition = el.style.transition || '';
    const previousWillChange = el.style.willChange || '';
    el.style.transition = 'all 240ms ease';
    el.style.willChange = 'transform, opacity, width, height, margin, padding, color, background-color, border-color, box-shadow';

    clearTimeout(el.__tirazPreviewTimer);
    el.__tirazPreviewTimer = setTimeout(() => {
      el.style.transition = previousTransition;
      el.style.willChange = previousWillChange;
    }, 260);
  }

  // ─── Baseline: get default computed styles for a tag ──
  // Creates a hidden bare element of the same tag and caches its styles
  const _baselineCache = {};
  function getBaseline(tagName) {
    const tag = (tagName || 'div').toLowerCase();
    if (_baselineCache[tag]) return _baselineCache[tag];

    const el = document.createElement(tag);
    el.style.cssText = 'all:initial;position:fixed;top:-9999px;left:-9999px;visibility:hidden;pointer-events:none;';
    document.documentElement.appendChild(el);
    const cs = window.getComputedStyle(el);
    const map = {};
    for (let i = 0; i < cs.length; i++) {
      map[cs[i]] = cs.getPropertyValue(cs[i]).trim();
    }
    document.documentElement.removeChild(el);
    _baselineCache[tag] = map;
    return map;
  }

  // ─── Extract POSITIVE computed CSS properties ────────
  // Only returns properties whose value differs from the browser default
  // for a bare element of the same tag — i.e. properties actually applied.
  function extractStyles(el) {
    const computed = window.getComputedStyle(el);
    const baseline = getBaseline(el.tagName);
    const result = [];

    for (const group of GROUPS) {
      const props = [];
      for (const prop of group.props) {
        const val = computed.getPropertyValue(prop).trim();
        if (!val || val === 'initial' || val === 'unset') continue;
        const base = baseline[prop] || '';
        // Only include if it differs from the baseline default
        if (val !== base) {
          props.push({ prop, val, group: group.id });
        }
      }
      if (props.length) {
        result.push({ group, props });
      }
    }

    return result;
  }

  // ─── Extract ALL positive computed properties ────────
  // Same baseline-diffing approach but across every computed property
  function extractAllStyles(el) {
    const computed = window.getComputedStyle(el);
    const baseline = getBaseline(el.tagName);
    const all = [];
    for (let i = 0; i < computed.length; i++) {
      const prop = computed[i];
      const val = computed.getPropertyValue(prop).trim();
      const base = baseline[prop] || '';
      if (val && val !== base) {
        all.push({ prop, val });
      }
    }
    return all;
  }

  // ─── Get box model values ──────────────────────────
  function getBoxModel(el) {
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      width: Math.round(rect.width) + 'px',
      height: Math.round(rect.height) + 'px',
      marginTop: cs.marginTop,
      marginRight: cs.marginRight,
      marginBottom: cs.marginBottom,
      marginLeft: cs.marginLeft,
      paddingTop: cs.paddingTop,
      paddingRight: cs.paddingRight,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
      borderTop: cs.borderTopWidth,
      borderRight: cs.borderRightWidth,
      borderBottom: cs.borderBottomWidth,
      borderLeft: cs.borderLeftWidth,
    };
  }

  // ─── SVG helpers ──────────────────────────────────
  function svg(paths, size = 14) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  }

  const ICONS = {
    close: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
    pin: svg('<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>'),
    copy: svg('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
    check: svg('<polyline points="20 6 9 17 4 12"/>'),
    search: svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    chevron: svg('<polyline points="6 9 12 15 18 9"/>'),
    inspect: svg('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>'),
  };

  // ─── Build panel HTML ──────────────────────────────
  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'TIRAZ-panel';

    panel.innerHTML = `
      <div id="TIRAZ-header">
        <div id="TIRAZ-logo">
          <span id="TIRAZ-title">TIRAZ <span style='font-size:10px;color: #4a5568 !important;'>V0.1.1</span></span>
          <span id="TIRAZ-selector-badge">—</span>
        </div>
        <div id="TIRAZ-header-actions">
          <button class="TIRAZ-header-btn" id="TIRAZ-pin-btn" title="Pin panel">${ICONS.pin}</button>
          <button class="TIRAZ-header-btn" id="TIRAZ-inspect-btn" title="Toggle inspect mode (Ctrl+Shift+F)">${ICONS.inspect}</button>
          <button class="TIRAZ-header-btn" id="TIRAZ-close-btn" title="Close">${ICONS.close}</button>
        </div>
      </div>

      <div id="TIRAZ-tabs">
        <div class="TIRAZ-tab active" data-tab="computed">Computed</div>
        <div class="TIRAZ-tab" data-tab="all">All Properties</div>
        <div class="TIRAZ-tab" data-tab="boxmodel">Box Model</div>
      </div>

      <div id="TIRAZ-search-wrap">
        <span id="TIRAZ-search-icon">${svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>', 13)}</span>
        <input id="TIRAZ-search" type="text" placeholder="Filter properties…" autocomplete="off" spellcheck="false" />
      </div>

      <div id="TIRAZ-body">
        <div id="TIRAZ-empty">
          ${svg('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>', 36)}
          <span>Hold <kbd style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:4px;padding:1px 5px;font-family:monospace;font-size:11px;">Ctrl</kbd> and click any element</span>
          <span style="font-size:11px;opacity:0.6">or press <kbd style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:4px;padding:1px 5px;font-family:monospace;font-size:10px;">Ctrl+Shift+F</kbd> to toggle inspect mode</span>
        </div>
      </div>

      <div id="TIRAZ-footer">
        <span id="TIRAZ-footer-info">0 properties</span>
        <button id="TIRAZ-copy-all-btn">Copy CSS</button>
      </div>
    `;

    return panel;
  }

  // ─── Highlight overlay ─────────────────────────────
  function createOverlay() {
    const hl = document.createElement('div');
    hl.id = 'TIRAZ-highlight';
    hl.style.display = 'none';
    document.documentElement.appendChild(hl);

    const label = document.createElement('div');
    label.id = 'TIRAZ-label';
    label.style.display = 'none';
    document.documentElement.appendChild(label);

    return { hl, label };
  }

  // ─── Mode badge ────────────────────────────────────
  function createModeBadge() {
    const badge = document.createElement('div');
    badge.id = 'TIRAZ-mode-badge';
    badge.innerHTML = `<div id="TIRAZ-mode-dot"></div> Inspect Mode`;
    document.documentElement.appendChild(badge);
    return badge;
  }

  // ─── Toast ─────────────────────────────────────────
  let toastTimeout = null;
  function showToast(msg) {
    let toast = document.getElementById('TIRAZ-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'TIRAZ-toast';
      document.documentElement.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 2000);
  }

  // ─── Render property row ───────────────────────────
  function renderRow(prop, val, extra = '') {
    const colorSwatch = isColorValue(val)
      ? `<span class="TIRAZ-color-swatch" style="background:${val}"></span>`
      : '';
    const safeProp = escapeHtml(prop);
    const safeVal = escapeHtml(val);
    return `
      <div class="TIRAZ-row" data-prop="${safeProp}">
        <span class="TIRAZ-prop">${safeProp}</span>
        <div class="TIRAZ-val-wrap">
          <span class="TIRAZ-val">${colorSwatch}${safeVal}${extra}</span>
          <input class="TIRAZ-property-input" type="text" value="${safeVal}" data-prop="${safeProp}" aria-label="Edit ${safeProp}" />
        </div>
        <div class="TIRAZ-row-actions">
          <button class="TIRAZ-edit-btn" type="button" data-prop="${safeProp}" title="Edit property">Edit</button>
          <button class="TIRAZ-copy-btn" data-copy="${safeProp}: ${safeVal};">
            ${ICONS.copy}
          </button>
        </div>
      </div>`;
  }

  function bindInlineEditors(body) {
    if (!body) return;

    body.querySelectorAll('.TIRAZ-row').forEach(row => {
      const prop = row.dataset.prop;
      const display = row.querySelector('.TIRAZ-val');
      const input = row.querySelector('.TIRAZ-property-input');
      const editBtn = row.querySelector('.TIRAZ-edit-btn');
      const copyBtn = row.querySelector('.TIRAZ-copy-btn');

      if (!prop || !display || !input || !editBtn) return;

      const syncDisplay = (nextValue) => {
        const safeValue = escapeHtml(nextValue || '');
        const swatch = isColorValue(nextValue || '')
          ? `<span class="TIRAZ-color-swatch" style="background:${escapeHtml(nextValue || '')}"></span>`
          : '';
        display.innerHTML = `${swatch}${safeValue}`;
        if (copyBtn) {
          copyBtn.setAttribute('data-copy', `${prop}: ${nextValue};`);
        }
      };

      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        row.classList.add('editing');
        input.style.display = 'block';
        display.style.display = 'none';
        input.focus();
        input.select();
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') {
          const originalValue = display.textContent.trim();
          input.value = originalValue;
          input.blur();
        }
      });

      input.addEventListener('blur', () => {
        const nextValue = (input.value || '').trim();
        row.classList.remove('editing');
        input.style.display = 'none';
        display.style.display = 'flex';

        if (!currentElement) return;
        currentElement.style.setProperty(prop, nextValue);
        applySmoothPreview(currentElement);

        if (nextValue) {
          syncDisplay(nextValue);
        } else {
          const fallback = window.getComputedStyle(currentElement).getPropertyValue(prop).trim() || 'initial';
          input.value = fallback;
          syncDisplay(fallback);
        }
      });

      input.addEventListener('input', (e) => {
        const nextValue = (e.target.value || '').trim();
        if (!currentElement) return;
        currentElement.style.setProperty(prop, nextValue);
        applySmoothPreview(currentElement);
        if (nextValue) syncDisplay(nextValue);
      });
    });
  }

  // ─── Render computed tab ───────────────────────────
  function renderComputed(groups) {
    if (!groups || !groups.length) return '';
    let html = '';
    for (const { group, props } of groups) {
      const filtered = searchQuery
        ? props.filter(p => p.prop.includes(searchQuery) || p.val.toLowerCase().includes(searchQuery))
        : props;
      if (!filtered.length) continue;

      const collapsed = collapsedGroups.has(group.id) ? 'collapsed' : '';
      html += `
        <div class="TIRAZ-group">
          <div class="TIRAZ-group-header ${collapsed}" data-group="${group.id}">
            <span class="TIRAZ-group-dot" style="background:${group.color}"></span>
            ${group.label}
            <span style="color:${group.color};margin-left:4px;font-size:9px;">${filtered.length}</span>
            <span class="TIRAZ-chevron">${svg('<polyline points="6 9 12 15 18 9"/>', 12)}</span>
          </div>
          <div class="TIRAZ-group-items ${collapsed}">
            ${filtered.map(({ prop, val }) => renderRow(prop, val)).join('')}
          </div>
        </div>`;
    }
    return html || `<div class="TIRAZ-empty"><span>No matching properties</span></div>`;
  }

  // ─── Render all-props tab ──────────────────────────
  function renderAll(allProps) {
    if (!allProps || !allProps.length) return '';
    const filtered = searchQuery
      ? allProps.filter(p => p.prop.includes(searchQuery) || p.val.toLowerCase().includes(searchQuery))
      : allProps;
    if (!filtered.length) return `<div class="TIRAZ-empty"><span>No matching properties</span></div>`;
    return filtered.map(({ prop, val }) => renderRow(prop, val)).join('');
  }

  // ─── Render box model tab ──────────────────────────
  function renderBoxModel(bm) {
    if (!bm) return '';
    return `
      <div id="TIRAZ-box-model">
        <div class="TIRAZ-bm-container">
          <div class="TIRAZ-bm-margin">
            <div class="TIRAZ-bm-label">
              <span style="color:#fbbf24">margin</span>
              <span>${bm.marginTop} / ${bm.marginRight} / ${bm.marginBottom} / ${bm.marginLeft}</span>
            </div>
            <div class="TIRAZ-bm-border">
              <div class="TIRAZ-bm-label">
                <span style="color:#f59e0b">border</span>
                <span>${bm.borderTop} / ${bm.borderRight} / ${bm.borderBottom} / ${bm.borderLeft}</span>
              </div>
              <div class="TIRAZ-bm-padding">
                <div class="TIRAZ-bm-label">
                  <span style="color:#34d399">padding</span>
                  <span>${bm.paddingTop} / ${bm.paddingRight} / ${bm.paddingBottom} / ${bm.paddingLeft}</span>
                </div>
                <div class="TIRAZ-bm-content">
                  ${bm.width} × ${bm.height}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div style="margin-top:14px">
          ${[
        ['Width', bm.width],
        ['Height', bm.height],
        ['Margin', `${bm.marginTop} ${bm.marginRight} ${bm.marginBottom} ${bm.marginLeft}`],
        ['Padding', `${bm.paddingTop} ${bm.paddingRight} ${bm.paddingBottom} ${bm.paddingLeft}`],
        ['Border', `${bm.borderTop} ${bm.borderRight} ${bm.borderBottom} ${bm.borderLeft}`],
      ].map(([k, v]) => renderRow(k, v)).join('')}
        </div>
      </div>`;
  }

  // ─── Update panel content ──────────────────────────
  function updatePanel() {
    if (!panelVisible || !currentElement) return;

    const body = document.getElementById('TIRAZ-body');
    if (!body) return;

    const computedGroups = extractStyles(currentElement);
    const allProps = extractAllStyles(currentElement);
    const bm = getBoxModel(currentElement);
    allProperties = allProps;

    // Footer
    const footerInfo = document.getElementById('TIRAZ-footer-info');
    if (footerInfo) footerInfo.textContent = `${allProps.length} properties`;

    // Render based on active tab
    let html = '';
    if (currentTab === 'computed') html = renderComputed(computedGroups);
    else if (currentTab === 'all') html = renderAll(allProps);
    else if (currentTab === 'boxmodel') html = renderBoxModel(bm);

    body.innerHTML = html || `<div id="TIRAZ-empty">No data</div>`;

    // Bind copy buttons
    body.querySelectorAll('.TIRAZ-copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = btn.getAttribute('data-copy');
        navigator.clipboard.writeText(text).then(() => {
          btn.innerHTML = ICONS.check;
          btn.classList.add('copied');
          showToast('Copied!');
          setTimeout(() => {
            btn.innerHTML = ICONS.copy;
            btn.classList.remove('copied');
          }, 1500);
        });
      });
    });

    bindInlineEditors(body);

    // Bind group collapse toggles
    body.querySelectorAll('.TIRAZ-group-header').forEach(header => {
      header.addEventListener('click', () => {
        const groupId = header.getAttribute('data-group');
        if (collapsedGroups.has(groupId)) {
          collapsedGroups.delete(groupId);
        } else {
          collapsedGroups.add(groupId);
        }
        header.classList.toggle('collapsed');
        const items = header.nextElementSibling;
        if (items) items.classList.toggle('collapsed');
      });
    });
  }

  // ─── Position panel smartly near click ────────────
  function positionPanel(panel, x, y) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const PW = 390;
    const PH = 500;
    const MARGIN = 16;

    let left = x + 16;
    let top = y - 60;

    if (left + PW > W - MARGIN) left = x - PW - 16;
    if (left < MARGIN) left = MARGIN;
    if (top + PH > H - MARGIN) top = H - PH - MARGIN;
    if (top < MARGIN) top = MARGIN;

    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  // ─── Show panel ────────────────────────────────────
  function showPanel(el, x, y) {
    currentElement = el;

    let panel = document.getElementById('TIRAZ-panel');
    if (!panel) {
      panel = buildPanel();
      document.documentElement.appendChild(panel);
      initPanelEvents(panel);
    }

    const selectorBadge = document.getElementById('TIRAZ-selector-badge');
    if (selectorBadge) selectorBadge.textContent = getSelector(el);

    if (!panelVisible) {
      positionPanel(panel, x, y);
    }

    panel.style.display = 'flex';
    panelVisible = true;
    panel.style.animation = 'none';
    panel.offsetHeight; // reflow
    panel.style.animation = '';

    updatePanel();
  }

  // ─── Hide panel ────────────────────────────────────
  function hidePanel() {
    const panel = document.getElementById('TIRAZ-panel');
    if (panel) panel.style.display = 'none';
    panelVisible = false;
  }

  // ─── Update highlight overlay ──────────────────────
  function updateHighlight(el) {
    const hl = document.getElementById('TIRAZ-highlight');
    const label = document.getElementById('TIRAZ-label');
    if (!hl || !label || !el) return;

    const rect = el.getBoundingClientRect();
    hl.style.cssText = `
      display: block;
      left: ${rect.left}px;
      top: ${rect.top}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
    `;

    const sel = getSelector(el);
    label.textContent = sel;
    label.style.display = 'block';

    const labelX = Math.min(rect.left, window.innerWidth - 200);
    const labelY = rect.top > 28 ? rect.top - 26 : rect.bottom + 4;
    label.style.left = labelX + 'px';
    label.style.top = labelY + 'px';
  }

  // ─── Clear highlight ───────────────────────────────
  function clearHighlight() {
    const hl = document.getElementById('TIRAZ-highlight');
    const label = document.getElementById('TIRAZ-label');
    if (hl) hl.style.display = 'none';
    if (label) label.style.display = 'none';
  }

  // ─── Init panel event listeners ───────────────────
  function initPanelEvents(panel) {
    // Close button
    document.getElementById('TIRAZ-close-btn').addEventListener('click', () => {
      hidePanel();
      setInspectMode(false);
    });

    // Inspect toggle button
    document.getElementById('TIRAZ-inspect-btn').addEventListener('click', () => {
      setInspectMode(!inspectModeActive);
    });

    // Tabs
    panel.querySelectorAll('.TIRAZ-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        panel.querySelectorAll('.TIRAZ-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentTab = tab.getAttribute('data-tab');
        updatePanel();
      });
    });

    // Search
    document.getElementById('TIRAZ-search').addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      updatePanel();
    });

    // Copy all CSS
    document.getElementById('TIRAZ-copy-all-btn').addEventListener('click', () => {
      if (!currentElement) return;
      const computed = window.getComputedStyle(currentElement);
      const selector = getSelector(currentElement);
      let css = `${selector} {\n`;
      for (let i = 0; i < computed.length; i++) {
        const prop = computed[i];
        css += `  ${prop}: ${computed.getPropertyValue(prop)};\n`;
      }
      css += '}';
      navigator.clipboard.writeText(css).then(() => showToast('Full CSS copied!'));
    });

    // Drag
    const header = document.getElementById('TIRAZ-header');
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.TIRAZ-header-btn')) return;
      isDragging = true;
      const rect = panel.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      let newLeft = e.clientX - dragOffsetX;
      let newTop = e.clientY - dragOffsetY;
      newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - panel.offsetWidth));
      newTop = Math.max(0, Math.min(newTop, window.innerHeight - panel.offsetHeight));
      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      document.body.style.userSelect = '';
    });

    // Stop panel clicks from propagating
    panel.addEventListener('click', e => e.stopPropagation());
    panel.addEventListener('mousedown', e => {
      if (!e.target.closest('#TIRAZ-header')) e.stopPropagation();
    });
  }

  // ─── Toggle inspect mode ───────────────────────────
  function setInspectMode(active) {
    inspectModeActive = active;
    const badge = document.getElementById('TIRAZ-mode-badge');
    const inspectBtn = document.getElementById('TIRAZ-inspect-btn');

    if (active) {
      document.body.style.cursor = 'crosshair';
      if (badge) badge.classList.add('visible');
      if (inspectBtn) inspectBtn.classList.add('active');
    } else {
      document.body.style.cursor = '';
      if (badge) badge.classList.remove('visible');
      if (inspectBtn) inspectBtn.classList.remove('active');
      clearHighlight();
    }
  }

  // ─── Init DOM elements ─────────────────────────────
  createOverlay();
  const modeBadge = createModeBadge();

  // ─── Global event listeners ────────────────────────

  // Ctrl+Click → inspect element
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('TIRAZ-panel');
    if (panel && panel.contains(e.target)) return;

    if (e.ctrlKey || inspectModeActive) {
      e.preventDefault();
      e.stopPropagation();

      const el = e.target;
      if (el.id === 'TIRAZ-highlight' || el.id === 'TIRAZ-label' || el.id === 'TIRAZ-mode-badge') return;

      showPanel(el, e.clientX, e.clientY);
      if (!inspectModeActive) clearHighlight();
    }
  }, true);

  // Mouse hover in inspect mode
  document.addEventListener('mouseover', (e) => {
    if (!inspectModeActive) return;
    const panel = document.getElementById('TIRAZ-panel');
    if (panel && panel.contains(e.target)) return;
    const el = e.target;
    if (['TIRAZ-highlight', 'TIRAZ-label', 'TIRAZ-mode-badge'].includes(el.id)) return;
    updateHighlight(el);
  });

  document.addEventListener('mouseout', (e) => {
    if (!inspectModeActive) return;
    const panel = document.getElementById('TIRAZ-panel');
    if (panel && panel.contains(e.relatedTarget)) return;
  });

  // Ctrl+Shift+F → toggle inspect mode
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'F') {
      e.preventDefault();
      setInspectMode(!inspectModeActive);
      // Open panel if not visible
      if (inspectModeActive && !panelVisible) {
        let panel = document.getElementById('TIRAZ-panel');
        if (!panel) {
          panel = buildPanel();
          document.documentElement.appendChild(panel);
          initPanelEvents(panel);
        }
        panel.style.left = (window.innerWidth - 400) + 'px';
        panel.style.top = '80px';
        panel.style.display = 'flex';
        panelVisible = true;
        updatePanel();
      }
    }

    // Escape → exit inspect mode
    if (e.key === 'Escape') {
      if (inspectModeActive) setInspectMode(false);
      else if (panelVisible) hidePanel();
    }
  });

  // ─── Chrome message listener (from popup) ─────────
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'TIRAZ-ping') {
        sendResponse({ ok: true });
      }
      if (msg.type === 'TIRAZ-toggle-inspect') {
        setInspectMode(!inspectModeActive);
        if (inspectModeActive && !panelVisible) {
          let panel = document.getElementById('TIRAZ-panel');
          if (!panel) {
            panel = buildPanel();
            document.documentElement.appendChild(panel);
            initPanelEvents(panel);
          }
          panel.style.left = (window.innerWidth - 400) + 'px';
          panel.style.top = '80px';
          panel.style.display = 'flex';
          panelVisible = true;
          updatePanel();
        }
      }
    });
  }

})();
