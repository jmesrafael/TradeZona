/**
 * theme.js — TradeZona Design System
 * ─────────────────────────────────────────────────────────────
 * Single source of truth for ALL visual design across the app.
 * Include in every page: <script src="theme.js"></script>
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  TO CHANGE THE ENTIRE APP APPEARANCE:                   │
 * │  Edit TZ.tokens.dark / TZ.tokens.light below.           │
 * │  Everything — colors, fonts, radius, spacing — is here. │
 * └─────────────────────────────────────────────────────────┘
 */

window.TZ = window.TZ || {};

// ══════════════════════════════════════════════════════════════
//  1. COLOR TOKENS  — edit here to retheme the whole app
// ══════════════════════════════════════════════════════════════
TZ.tokens = {
  dark: {
    '--bg':      '#0b0f0c',   // page background
    '--panel':   '#111816',   // card / panel background
    '--panel2':  '#161d1a',   // secondary panel (modals, strips)
    '--accent':  '#00ff88',   // primary green — buttons, highlights
    '--accent2': '#19c37d',   // secondary green — icons, borders
    '--border':  '#1c2a25',   // default border
    '--border2': '#243530',   // slightly stronger border
    '--text':    '#e6f2ec',   // primary text
    '--muted':   '#8fa39a',   // secondary / placeholder text
    '--muted2':  '#5c7068',   // tertiary / disabled text
    '--red':     '#ff5f6d',   // error / loss / danger
    '--amber':   '#f59e0b',   // warning / unsaved
    '--blue':    '#60a5fa',   // info
  },
  light: {
    '--bg':      '#eef3f0',
    '--panel':   '#ffffff',
    '--panel2':  '#e8f0ec',
    '--accent':  '#19c37d',
    '--accent2': '#0a9460',
    '--border':  '#c4d4cc',
    '--border2': '#b5c8bf',
    '--text':    '#0a1812',
    '--muted':   '#2e5044',
    '--muted2':  '#4a7065',
    '--red':     '#dc2626',
    '--amber':   '#b45309',
    '--blue':    '#1d4ed8',
  }
};

// ══════════════════════════════════════════════════════════════
//  2. TYPOGRAPHY  — fonts used across the app
// ══════════════════════════════════════════════════════════════
TZ.fonts = {
  heading: "'Space Grotesk', sans-serif",  // headings, labels, numbers
  body:    "'Inter', sans-serif",           // body text, inputs
};

// ══════════════════════════════════════════════════════════════
//  3. SHAPE TOKENS  — border radius & spacing scale
// ══════════════════════════════════════════════════════════════
TZ.shape = {
  radius: { sm:'6px', md:'8px', lg:'10px', xl:'12px', pill:'20px' },
  spacing:{ xs:'4px', sm:'8px', md:'12px', lg:'18px', xl:'24px' },
};

// ══════════════════════════════════════════════════════════════
//  4. LOADER CONFIG  — candlestick loader settings
// ══════════════════════════════════════════════════════════════
TZ.loader = {
  // Word shown below candles during loading — change this to rebrand
  brandWord: 'TradeZona',
  // Candle layout: each item is { color: 'green'|'red', height, bodyH, bodyTop }
  // Adjust freely — the loader reads this array at runtime
  candles: [
    { color:'green', height:70,  bodyH:35, bodyTop:20 },
    { color:'red',   height:100, bodyH:60, bodyTop:20 },
    { color:'green', height:60,  bodyH:30, bodyTop:15 },
    { color:'green', height:110, bodyH:70, bodyTop:25 },
    { color:'red',   height:80,  bodyH:45, bodyTop:20 },
    { color:'green', height:95,  bodyH:55, bodyTop:25 },
  ],
};

// ══════════════════════════════════════════════════════════════
//  5. THEME ENGINE  — don't normally need to edit below here
// ══════════════════════════════════════════════════════════════
TZ.applyTheme = function(mode) {
  const pref   = mode || localStorage.getItem('tl_theme') || 'dark';
  const isDark = pref === 'dark' ||
    (pref === 'system' && !window.matchMedia('(prefers-color-scheme:light)').matches);
  const tokens = isDark ? TZ.tokens.dark : TZ.tokens.light;
  const root   = document.documentElement;
  Object.entries(tokens).forEach(([k, v]) => root.style.setProperty(k, v));
  root.dataset.theme   = isDark ? 'dark' : 'light';
  TZ.currentTheme = isDark ? 'dark' : 'light';
  // Shorthand refs for Chart.js and JS consumers
  TZ.accent  = tokens['--accent'];
  TZ.accent2 = tokens['--accent2'];
  TZ.muted   = tokens['--muted'];
  TZ.border  = tokens['--border'];
  TZ.text    = tokens['--text'];
  TZ.red     = tokens['--red'];
};

TZ.setTheme = function(mode) {
  localStorage.setItem('tl_theme', mode);
  TZ.applyTheme(mode);
  // Broadcast to all iframes
  document.querySelectorAll('iframe').forEach(f => {
    try { f.contentWindow.postMessage({ type:'tz_theme', theme:mode }, '*'); } catch(e) {}
  });
};

// ── Listen for theme messages from parent ──────────────────────
window.addEventListener('message', function(e) {
  if (e.data?.type === 'tz_theme')            TZ.applyTheme(e.data.theme);
  if (e.data?.theme && !e.data?.type)         TZ.applyTheme(e.data.theme);
});

// ── Backward-compat alias ──────────────────────────────────────
window.applyTheme = TZ.applyTheme;

// ── Auto-apply on load ─────────────────────────────────────────
TZ.applyTheme();

// ══════════════════════════════════════════════════════════════
//  6. CANDLESTICK PAGE LOADER
//     Injects the loader into any page that has id="pageLoader".
//     Auto-removes itself once the page calls TZ.hideLoader().
// ══════════════════════════════════════════════════════════════
TZ.buildLoader = function() {
  const el = document.getElementById('pageLoader');
  if (!el) return;

  const cfg   = TZ.loader;
  const dark  = TZ.tokens.dark;
  const light = TZ.tokens.light;

  el.innerHTML = `
    <style>
      #pageLoader {
        position:fixed;inset:0;
        background:var(--bg);
        display:flex;flex-direction:column;
        align-items:center;justify-content:center;
        gap:22px;z-index:9999;
        transition:opacity .4s ease;
      }
      #pageLoader.gone { opacity:0;pointer-events:none; }

      .tz-chart {
        display:flex;gap:10px;align-items:flex-end;
      }

      .tz-candle {
        position:relative;
        display:flex;
        flex-direction:column;
        align-items:center;
        animation:tzFloat 2s ease-in-out infinite;
      }

      .tz-wick {
        width:2px;border-radius:2px;opacity:.9;flex-shrink:0;
      }
      .tz-body {
        width:11px;border-radius:3px;position:absolute;z-index:2;
      }

      /* Green candle */
      .tz-g .tz-body { background:${dark['--accent']};box-shadow:0 0 10px ${dark['--accent']}99; }
      .tz-g .tz-wick { background:${dark['--accent']};box-shadow:0 0 6px ${dark['--accent']}88; }
      [data-theme="light"] .tz-g .tz-body { background:${light['--accent']};box-shadow:0 0 10px ${light['--accent']}66; }
      [data-theme="light"] .tz-g .tz-wick { background:${light['--accent2']};box-shadow:none; }

      /* Red candle */
      .tz-r .tz-body { background:${dark['--red']};box-shadow:0 0 10px ${dark['--red']}88; }
      .tz-r .tz-wick { background:${dark['--red']};box-shadow:0 0 6px ${dark['--red']}77; }
      [data-theme="light"] .tz-r .tz-body { background:${light['--red']};box-shadow:0 0 8px ${light['--red']}55; }
      [data-theme="light"] .tz-r .tz-wick { background:${light['--red']};box-shadow:none; }

      @keyframes tzFloat {
        0%,100% { transform:translateY(6px); }
        50%      { transform:translateY(-12px); }
      }

      .tz-brand {
        font-family:'Space Grotesk',sans-serif;
        font-size:15px;font-weight:600;letter-spacing:.5px;
        color:var(--muted);
        display:flex;align-items:center;gap:4px;
      }
      .tz-brand span { color:var(--accent); }
    </style>

    <div class="tz-chart" id="tzCandleChart"></div>
    <div class="tz-brand">Trade<span>Zona</span></div>
  `;

  // Build candles from config
  const chart = document.getElementById('tzCandleChart');
  cfg.candles.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = `tz-candle tz-${c.color === 'red' ? 'r' : 'g'}`;
    div.style.cssText = `height:${c.height}px;animation-delay:${i * 0.18}s`;

    const wick = document.createElement('div');
    wick.className = 'tz-wick';
    wick.style.height = c.height + 'px';

    const body = document.createElement('div');
    body.className = 'tz-body';
    body.style.cssText = `height:${c.bodyH}px;top:${c.bodyTop}px`;

    div.appendChild(wick);
    div.appendChild(body);
    chart.appendChild(div);
  });
};

TZ.hideLoader = function() {
  const el = document.getElementById('pageLoader');
  if (el) {
    el.classList.add('gone');
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 450);
  }
};

// Auto-build on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', TZ.buildLoader);
} else {
  TZ.buildLoader();
}

// ══════════════════════════════════════════════════════════════
//  7. TAB LOADER (mini candlestick — for iframes & tab panels)
//     Call TZ.buildTabLoader(containerEl) to inject a small
//     candlestick spinner into any .tab-loader div.
//     Call TZ.hideTabLoader(containerEl) to fade it out.
//
//     In iframes: just add <div id="tzTabLoader"></div> and
//     theme.js auto-builds it. Call TZ.hideTabLoader() when ready.
// ══════════════════════════════════════════════════════════════

// Shared CSS — injected once per document
TZ._tabLoaderStyleInjected = false;
TZ._injectTabLoaderStyle = function() {
  if (TZ._tabLoaderStyleInjected) return;
  TZ._tabLoaderStyleInjected = true;
  const dark  = TZ.tokens.dark;
  const light = TZ.tokens.light;
  const s = document.createElement('style');
  s.id = 'tz-tab-loader-styles';
  s.textContent = `
    .tz-tl {
      position:absolute;inset:0;
      background:var(--bg);
      display:flex;flex-direction:column;
      align-items:center;justify-content:center;
      gap:14px;z-index:10;
      transition:opacity .3s ease;
    }
    .tz-tl.gone { opacity:0;pointer-events:none; }
    .tz-tl-chart { display:flex;gap:7px;align-items:flex-end; }
    .tz-tl-candle {
      position:relative;display:flex;flex-direction:column;
      align-items:center;
      animation:tzTabFloat 1.8s ease-in-out infinite;
    }
    .tz-tl-wick { width:2px;border-radius:2px;opacity:.85;flex-shrink:0; }
    .tz-tl-body { width:8px;border-radius:2px;position:absolute;z-index:2; }
    .tz-tl-g .tz-tl-body { background:${dark['--accent']};box-shadow:0 0 7px ${dark['--accent']}88; }
    .tz-tl-g .tz-tl-wick { background:${dark['--accent']}; }
    .tz-tl-r .tz-tl-body { background:${dark['--red']};box-shadow:0 0 7px ${dark['--red']}77; }
    .tz-tl-r .tz-tl-wick { background:${dark['--red']}; }
    [data-theme="light"] .tz-tl-g .tz-tl-body { background:${light['--accent']};box-shadow:0 0 6px ${light['--accent']}55; }
    [data-theme="light"] .tz-tl-g .tz-tl-wick { background:${light['--accent2']}; }
    [data-theme="light"] .tz-tl-r .tz-tl-body { background:${light['--red']};box-shadow:0 0 5px ${light['--red']}44; }
    [data-theme="light"] .tz-tl-r .tz-tl-wick { background:${light['--red']}; }
    @keyframes tzTabFloat {
      0%,100% { transform:translateY(4px); }
      50%      { transform:translateY(-8px); }
    }
    .tz-tl-label {
      font-family:'Inter',sans-serif;font-size:12px;
      color:var(--muted);letter-spacing:.2px;
    }
  `;
  document.head.appendChild(s);
};

// Mini candle config — 4 candles, smaller scale
TZ._tabCandles = [
  { color:'green', height:44, bodyH:22, bodyTop:12 },
  { color:'red',   height:60, bodyH:36, bodyTop:12 },
  { color:'green', height:36, bodyH:18, bodyTop:10 },
  { color:'green', height:66, bodyH:40, bodyTop:14 },
  { color:'red',   height:48, bodyH:28, bodyTop:12 },
];

TZ.buildTabLoader = function(container, label) {
  if (!container) return;
  TZ._injectTabLoaderStyle();

  const wrap = document.createElement('div');
  wrap.className = 'tz-tl';

  const chart = document.createElement('div');
  chart.className = 'tz-tl-chart';

  TZ._tabCandles.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = `tz-tl-candle tz-tl-${c.color === 'red' ? 'r' : 'g'}`;
    div.style.cssText = `height:${c.height}px;animation-delay:${i * 0.16}s`;
    const wick = document.createElement('div');
    wick.className = 'tz-tl-wick';
    wick.style.height = c.height + 'px';
    const body = document.createElement('div');
    body.className = 'tz-tl-body';
    body.style.cssText = `height:${c.bodyH}px;top:${c.bodyTop}px`;
    div.appendChild(wick);
    div.appendChild(body);
    chart.appendChild(div);
  });

  wrap.appendChild(chart);

  if (label !== false) {
    const lbl = document.createElement('div');
    lbl.className = 'tz-tl-label';
    lbl.textContent = label || 'Loading…';
    wrap.appendChild(lbl);
  }

  // Clear existing content and append
  container.innerHTML = '';
  container.appendChild(wrap);
  return wrap;
};

TZ.hideTabLoader = function(container) {
  const wrap = container
    ? container.querySelector('.tz-tl')
    : document.querySelector('.tz-tl');
  if (!wrap) return;
  wrap.classList.add('gone');
  setTimeout(() => { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 350);
};

// ── Auto tab-loader for iframes ────────────────────────────────
// If a page loaded inside an iframe has <div id="tzTabLoader"></div>
// theme.js will auto-build the mini loader into it.
// Call TZ.hideTabLoader() when the page is ready.
(function() {
  const el = document.getElementById('tzTabLoader');
  if (!el) return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => TZ.buildTabLoader(el));
  } else {
    TZ.buildTabLoader(el);
  }
})();