// journal.js

document.addEventListener("DOMContentLoaded", () => {

  // ============================
  // State & Constants
  // ============================

  const TABS = ['logs', 'calendar', 'notes', 'analytics', 'settings'];

  let activeTab = 'logs';
  let journalId = sessionStorage.getItem('tz_current_journal');
  let journalObj = null;
  let settings = null;
  let currentUser = null;
  let userIsPro = false;
  let isDirty = false;
  let exportScope = 'full';
  let importMode = 'replace';
  let importPayload = null;
  let _lastRemovedTag = null;
  let _lastRemovedKey = null;
  let _undoTimer = null;
  let _tt;
  let _calcOpen = false;
  let _cAsset = 'crypto';
  let _flushTarget = null;
  let _flushTimer = null;


  // ============================
  // Initialization
  // ============================

  (async () => {
    currentUser = await requireAuth();
    if (!currentUser) return;
    if (!journalId) { location.href = '/dashboard'; return; }

    const profile = await getProfile(currentUser.id);
    userIsPro = profile?.plan === 'pro';
    window._userIsPro = userIsPro;

    document.getElementById('hUserName').textContent = profile?.name || currentUser.email;

    if (userIsPro) {
      document.getElementById('hPlanBadge').textContent = 'Pro';
      document.getElementById('hPlanBadge').className = 'plan-badge badge-pro';
    }

    const journals = await getJournals(currentUser.id);
    journalObj = journals.find(j => j.id === journalId);
    if (!journalObj) { location.href = '/dashboard'; return; }

    document.getElementById('jnameHdr').textContent = journalObj.name;
    document.title = 'TradeZona — ' + journalObj.name;

    settings = await getJournalSettings(journalId);
    bcast({ type: 'tz_plan', isPro: userIsPro });

    // Show pro duration in settings
    if (userIsPro && profile?.pro_expires_at) {
      const exp = new Date(profile.pro_expires_at);
      document.getElementById('proDurationRow').style.display = 'block';
      document.getElementById('proDurationText').textContent =
        'Active — renews ' + exp.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    } else if (userIsPro) {
      document.getElementById('proDurationRow').style.display = 'block';
      document.getElementById('proDurationText').textContent = 'Active';
    }

    document.getElementById('pageLoader').classList.add('gone');
    setTimeout(() => {
      const pl = document.getElementById('pageLoader');
      if (pl) pl.style.display = 'none';
    }, 400);

    const lf = document.getElementById('logsFrame');
    if (lf?.contentDocument?.readyState === 'complete') frameReady('logs');

    _preloadTabs();
  })();


  // ============================
  // Tab Preloading
  // ============================

  function _preloadTabs() {
    [
      { id: 'calFrame', src: 'calendar.html' },
      { id: 'notesFrame', src: 'notes.html' },
      { id: 'analyticsFrame', src: 'analytics.html' }
    ].forEach(({ id, src }) => {
      const f = document.getElementById(id);
      if (f && !f.src) f.src = src + '?preload=1';
    });
  }


  // ============================
  // Navigation
  // ============================

  function navigateSafely(dest) {
    const lf = document.getElementById('logsFrame');
    if (!lf?.contentWindow) { location.href = dest; return; }
    _flushTarget = dest;
    clearTimeout(_flushTimer);
    _flushTimer = setTimeout(() => { _flushTarget = null; location.href = dest; }, 2000);
    try {
      lf.contentWindow.postMessage({ type: 'tz_flush_request' }, '*');
    } catch (e) {
      location.href = dest;
    }
  }

  function goBack() {
    if (activeTab === 'settings' && isDirty) {
      showToast('Save or discard settings first.', 'fa-solid fa-triangle-exclamation', 'red');
      return;
    }
    navigateSafely('/dashboard');
  }

  // Expose goBack globally (called from HTML onclick)
  window.goBack = goBack;


  // ============================
  // Tab Switching
  // ============================

  function switchTab(name) {
    if (activeTab === 'settings' && isDirty && name !== 'settings') {
      showToast('Save or discard changes first.', 'fa-solid fa-triangle-exclamation', 'red');
      return;
    }

    TABS.forEach(t => {
      document.getElementById('tab-' + t).classList.toggle('active', t === name);
      document.querySelector(`[data-tab="${t}"]`)?.classList.toggle('active', t === name);
    });

    activeTab = name;

    const fm = {
      calendar: { id: 'calFrame', src: 'calendar.html' },
      notes: { id: 'notesFrame', src: 'notes.html' },
      analytics: { id: 'analyticsFrame', src: 'analytics.html' }
    };

    if (fm[name]) {
      const { id, src } = fm[name];
      const f = document.getElementById(id);
      if (f) {
        if (!f.src || f.src === 'about:blank') {
          showTabLoader(name);
          f.classList.remove('ready');
          f.src = src + '?t=' + Date.now();
        } else if (!f.classList.contains('ready')) {
          showTabLoader(name);
        }
      }
    }

    if (name === 'settings') populateSettings();

    document.getElementById('unsavedBar').classList.remove('show');
  }

  // Expose switchTab globally (called from HTML onclick)
  window.switchTab = switchTab;

  function showTabLoader(n) {
    const l = document.getElementById('loader-' + n);
    if (l) { l.style.display = ''; l.classList.remove('hidden'); }
  }

  function frameReady(n) {
    const map = {
      logs: 'logsFrame',
      calendar: 'calFrame',
      notes: 'notesFrame',
      analytics: 'analyticsFrame'
    };
    const f = document.getElementById(map[n]);
    const t = localStorage.getItem('tl_theme') || 'dark';
    const ft = localStorage.getItem('tl_font') || 'default';

    try {
      if (f?.contentWindow) {
        f.contentWindow.postMessage({ type: 'tz_theme', theme: t }, '*');
        f.contentWindow.postMessage({ type: 'tz_font', font: ft }, '*');
      }
    } catch (e) {}

    try {
      if (f?.contentWindow) f.contentWindow.postMessage({ type: 'tz_plan', isPro: userIsPro }, '*');
    } catch (e) {}

    if (f) {
      f.classList.add('ready');
      const l = document.getElementById('loader-' + n);
      if (l) {
        l.classList.add('hidden');
        setTimeout(() => { if (l.classList.contains('hidden')) l.style.display = 'none'; }, 350);
      }
    }
  }

  // Expose frameReady globally (called from iframe onload)
  window.frameReady = frameReady;

  function bcast(msg) {
    ['logsFrame', 'calFrame', 'notesFrame', 'analyticsFrame'].forEach(id => {
      const f = document.getElementById(id);
      try { if (f?.contentWindow) f.contentWindow.postMessage(msg, '*'); } catch (e) {}
    });
  }


  // ============================
  // Unsaved Changes Bar
  // ============================

  function markDirty() {
    isDirty = true;
    document.getElementById('unsavedBar').classList.add('show');
  }

  function clearDirty() {
    isDirty = false;
    document.getElementById('unsavedBar').classList.remove('show');
  }

  function discardChanges() {
    isDirty = false;
    document.getElementById('unsavedBar').classList.remove('show');
    populateSettings();
  }

  // Expose globally (called from HTML onclick)
  window.discardChanges = discardChanges;


  // ============================
  // Settings Population
  // ============================

  function populateSettings() {
    if (!journalObj || !settings) return;

    document.getElementById('js-name').value = journalObj.name || '';
    document.getElementById('js-capital').value = journalObj.capital || '';
    document.getElementById('showPnlToggle').classList.toggle('on', journalObj.show_pnl !== false);
    document.getElementById('showCapToggle').classList.toggle('on', journalObj.show_capital !== false);

    const aOn = localStorage.getItem('tl_analytics_on') !== 'false';
    const sw = document.getElementById('analyticsToggleSwitch');
    if (sw) sw.classList.toggle('on', aOn);

    renderPinSection();
    renderTagLists();
    renderMoodGrid();
    renderExportImport();
    clearDirty();
  }


  // ============================
  // PIN Section
  // ============================

  function renderPinSection() {
    const hasPin = !!(journalObj?.pin_hash);
    const badge = document.getElementById('pinBadge');
    const acts = document.getElementById('pinActionsRow');
    const form = document.getElementById('pinForm');

    document.getElementById('pinProNote').textContent = userIsPro ? '' : '(Pro plan only)';
    document.getElementById('pinNew').value = '';
    document.getElementById('pinConfirm').value = '';
    document.getElementById('pinMismatch').style.display = 'none';
    form.classList.remove('show');

    if (!userIsPro) {
      badge.className = 'pin-badge pro-only';
      badge.innerHTML = '<i class="fa-solid fa-lock"></i> Pro only';
      acts.innerHTML = `<button class="btn-pin" onclick="location.href='/subscription'" style="font-size:11px"><i class="fa-solid fa-arrow-up"></i> Upgrade</button>`;
      return;
    }

    if (hasPin) {
      badge.className = 'pin-badge active';
      badge.innerHTML = '<i class="fa-solid fa-lock"></i> PIN Active';
      acts.innerHTML = `<button class="btn-pin" onclick="showPinForm()"><i class="fa-solid fa-pen"></i> Change</button><button class="btn-pin btn-pin-danger" onclick="removePin()"><i class="fa-solid fa-lock-open"></i> Remove</button>`;
    } else {
      badge.className = 'pin-badge none';
      badge.innerHTML = '<i class="fa-solid fa-lock-open"></i> No PIN';
      acts.innerHTML = `<button class="btn-pin" onclick="showPinForm()"><i class="fa-solid fa-plus"></i> Add PIN</button>`;
    }
  }

  function showPinForm() {
    document.getElementById('pinForm').classList.add('show');
    document.getElementById('pinNew').focus();
    markDirty();
  }

  function onPinInput() {
    markDirty();
    const p = document.getElementById('pinNew').value;
    const c = document.getElementById('pinConfirm').value;
    document.getElementById('pinMismatch').style.display = (c.length > 0 && p !== c) ? 'block' : 'none';
  }

  async function removePin() {
    if (!confirm('Remove the PIN?')) return;
    try {
      await updateJournal(journalId, { pin_hash: null });
      journalObj.pin_hash = null;
      renderPinSection();
      showToast('PIN removed.', 'fa-solid fa-lock-open', 'green');
    } catch (e) {
      showToast('Error: ' + e.message, 'fa-solid fa-circle-exclamation', 'red');
    }
  }

  // Expose PIN functions globally (called from dynamically rendered HTML)
  window.showPinForm = showPinForm;
  window.removePin = removePin;
  window.onPinInput = onPinInput;


  // ============================
  // Journal Settings CRUD
  // ============================

  async function saveJournalSettings() {
    const name = document.getElementById('js-name').value.trim();
    const capital = document.getElementById('js-capital').value.trim();
    const pinNew = document.getElementById('pinNew').value.trim();
    const pinConf = document.getElementById('pinConfirm').value.trim();
    const upd = {};

    if (name) upd.name = name;
    if (capital !== '') upd.capital = parseFloat(capital) || null;

    if (userIsPro && document.getElementById('pinForm').classList.contains('show') && pinNew) {
      if (pinNew.length < 4) {
        showToast('PIN must be at least 4 digits.', 'fa-solid fa-circle-exclamation', 'red');
        return;
      }
      if (pinNew !== pinConf) {
        document.getElementById('pinMismatch').style.display = 'block';
        return;
      }
      upd.pin_hash = await hashPin(pinNew);
      document.getElementById('pinMismatch').style.display = 'none';
    }

    try {
      await updateJournal(journalId, upd);
      Object.assign(journalObj, upd);
      if (name) {
        document.getElementById('jnameHdr').textContent = name;
        document.title = 'TradeZona — ' + name;
      }
      renderPinSection();
      clearDirty();
      showToast('Settings saved!', 'fa-solid fa-circle-check', 'green');
    } catch (e) {
      showToast('Save failed: ' + e.message, 'fa-solid fa-circle-exclamation', 'red');
    }
  }

  // Expose globally (called from HTML onclick)
  window.saveJournalSettings = saveJournalSettings;

  async function toggleFlag(field) {
    const cur = journalObj[field] !== false;
    journalObj[field] = !cur;
    document.getElementById(field === 'show_pnl' ? 'showPnlToggle' : 'showCapToggle').classList.toggle('on', !cur);
    await updateJournal(journalId, { [field]: !cur });
    showToast('Display setting updated.', 'fa-solid fa-circle-check', 'green');
  }

  // Expose globally (called from HTML onclick)
  window.toggleFlag = toggleFlag;


  // ============================
  // Tag Lists (Strategies, Timeframes, Pairs)
  // ============================

  function renderTagLists() {
    renderTagList('strategies', 'stratList');
    renderTagList('timeframes', 'tfList');
    renderTagList('pairs', 'pairList');
  }

  function renderTagList(key, listId) {
    const list = settings?.[key] || [];
    document.getElementById(listId).innerHTML = list.map(t =>
      `<span class="stag">${esc(t)}<button class="rm" onclick="removeTag('${key}','${esc(t)}')"><i class="fa-solid fa-xmark" style="font-size:9px"></i></button></span>`
    ).join('');
  }

  async function addTag(key, inputId) {
    const inp = document.getElementById(inputId);
    let val = inp.value.trim();
    if (!val) return;
    if (key === 'pairs') val = val.toUpperCase();

    const list = settings[key] || [];
    if (!list.find(x => x.toLowerCase() === val.toLowerCase())) {
      settings[key] = [...list, val];
      await updateJournalSettings(journalId, { [key]: settings[key] });
      renderTagLists();
      bcast({ type: 'tz_settings_updated' });
      showToast(`Tag "${val}" added.`, 'fa-solid fa-circle-check', 'green');
    }
    inp.value = '';
  }

  async function removeTag(key, val) {
    _lastRemovedTag = val;
    _lastRemovedKey = key;
    settings[key] = (settings[key] || []).filter(t => t !== val);
    await updateJournalSettings(journalId, { [key]: settings[key] });
    renderTagLists();
    clearTimeout(_undoTimer);

    const t = document.getElementById('toast');
    document.getElementById('toastIcon').className = 'fa-solid fa-trash';
    document.getElementById('toastMsg').innerHTML =
      `Tag "<strong>${esc(val)}</strong>" removed. <button onclick="undoTagRemove()" style="background:var(--accent2);color:#0b0f0c;border:none;border-radius:5px;padding:3px 9px;font-size:11px;font-weight:700;cursor:pointer;margin-left:8px">Undo</button>`;
    t.className = 'show toast-red';

    _undoTimer = setTimeout(() => {
      t.classList.remove('show', 'toast-red');
      _lastRemovedTag = null;
      _lastRemovedKey = null;
    }, 3500);
  }

  async function undoTagRemove() {
    if (!_lastRemovedTag || !_lastRemovedKey) return;
    const key = _lastRemovedKey, val = _lastRemovedTag;
    const list = settings[key] || [];
    if (!list.includes(val)) {
      settings[key] = [...list, val];
      await updateJournalSettings(journalId, { [key]: settings[key] });
      renderTagLists();
      bcast({ type: 'tz_settings_updated' });
    }
    const t = document.getElementById('toast');
    t.classList.remove('show', 'toast-red');
    clearTimeout(_undoTimer);
    _lastRemovedTag = null;
    _lastRemovedKey = null;
    showToast(`Tag "${val}" restored.`, 'fa-solid fa-rotate-left', 'green');
  }

  // Expose globally (called from rendered HTML)
  window.addTag = addTag;
  window.removeTag = removeTag;
  window.undoTagRemove = undoTagRemove;


  // ============================
  // Mood Tags
  // ============================

  function renderMoodGrid() {
    const moods = settings?.moods || [];
    const colors = settings?.mood_colors || {};

    document.getElementById('moodGrid').innerHTML = moods.length
      ? moods.map(m => {
          const col = colors[m] || '#8fa39a';
          const [r, g, b] = [col.slice(1, 3), col.slice(3, 5), col.slice(5, 7)].map(x => parseInt(x, 16));
          const colorEl = userIsPro
            ? `<input type="color" class="mtag-color" value="${col}" style="background:${col}" oninput="updateMoodColor('${esc(m)}',this.value)" title="Change color">`
            : `<span class="mtag-dot" style="background:${col}"></span>`;
          return `<div class="mtag" style="background:rgba(${r},${g},${b},.15);color:${col};border-color:rgba(${r},${g},${b},.35)">${colorEl}<span>${esc(m)}</span><button class="mtag-rm" onclick="removeMoodTag('${esc(m)}')"><i class="fa-solid fa-xmark" style="font-size:9px"></i></button></div>`;
        }).join('')
      : '<span style="font-size:12px;color:var(--muted)">No moods yet.</span>';
  }

  async function addMoodTag() {
    const inp = document.getElementById('moodInput');
    const col = document.getElementById('moodColor').value;
    const val = inp.value.trim();
    if (!val) return;

    const moods = settings.moods || [];
    if (!moods.find(m => m.toLowerCase() === val.toLowerCase())) {
      settings.moods = [...moods, val];
      settings.mood_colors = { ...settings.mood_colors, [val]: col };
      await updateJournalSettings(journalId, { moods: settings.moods, mood_colors: settings.mood_colors });
      renderMoodGrid();
      bcast({ type: 'tz_settings_updated' });
      showToast(`Mood "${val}" added.`, 'fa-solid fa-circle-check', 'green');
    }
    inp.value = '';
    document.getElementById('moodColor').value = '#8fa39a';
  }

  async function removeMoodTag(val) {
    _lastRemovedTag = val;
    _lastRemovedKey = 'moods';
    settings.moods = settings.moods.filter(m => m !== val);
    const c = { ...settings.mood_colors };
    delete c[val];
    settings.mood_colors = c;
    await updateJournalSettings(journalId, { moods: settings.moods, mood_colors: settings.mood_colors });
    renderMoodGrid();
    bcast({ type: 'tz_settings_updated' });
    clearTimeout(_undoTimer);

    const t = document.getElementById('toast');
    document.getElementById('toastIcon').className = 'fa-solid fa-trash';
    document.getElementById('toastMsg').innerHTML =
      `Mood "<strong>${esc(val)}</strong>" removed. <button onclick="undoTagRemove()" style="background:var(--accent2);color:#0b0f0c;border:none;border-radius:5px;padding:3px 9px;font-size:11px;font-weight:700;cursor:pointer;margin-left:8px">Undo</button>`;
    t.className = 'show toast-red';

    _undoTimer = setTimeout(() => {
      t.classList.remove('show', 'toast-red');
      _lastRemovedTag = null;
      _lastRemovedKey = null;
    }, 3500);
  }

  async function updateMoodColor(mood, color) {
    settings.mood_colors = { ...settings.mood_colors, [mood]: color };
    await updateJournalSettings(journalId, { mood_colors: settings.mood_colors });
    renderMoodGrid();
    bcast({ type: 'tz_settings_updated' });
  }

  // Expose globally (called from rendered HTML)
  window.addMoodTag = addMoodTag;
  window.removeMoodTag = removeMoodTag;
  window.updateMoodColor = updateMoodColor;


  // ============================
  // Export & Import UI Render
  // ============================

  function renderExportImport() {
    const el = document.getElementById('exportImportContent');

    if (!userIsPro) {
      el.innerHTML = `<div class="pro-lock-box"><i class="fa-solid fa-lock lock-icon"></i><h4>Pro Feature</h4><p>Back up as <strong>.json</strong> (with images) or export as <strong>.csv</strong> for Excel.</p><button class="btn-upgrade" onclick="location.href='/subscription'"><i class="fa-solid fa-arrow-up"></i> Upgrade to Pro</button></div>`;
      return;
    }

    el.innerHTML = `<div class="io-grid"><button class="io-btn hi" onclick="openExport()"><div class="io-icon"><i class="fa-solid fa-file-arrow-down"></i></div><div class="io-label">JSON Backup</div><div class="io-desc">Full backup + images</div></button><button class="io-btn hi" onclick="exportCSV()"><div class="io-icon"><i class="fa-solid fa-file-csv"></i></div><div class="io-label">CSV Export</div><div class="io-desc">For Excel / Sheets</div></button><button class="io-btn" onclick="openImport()"><div class="io-icon"><i class="fa-solid fa-file-arrow-up"></i></div><div class="io-label">Import</div><div class="io-desc">Restore from .json</div></button></div><div class="io-note"><i class="fa-solid fa-circle-info"></i><span>JSON backup includes all images as embedded base64 data. CSV exports all trade fields for spreadsheet analysis.</span></div>`;
  }


  // ============================
  // CSV Export
  // ============================

  async function exportCSV() {
    try {
      const trades = await getTrades(journalId);
      const rows = trades.map(dbToTrade);

      const headers = ['Date', 'Time', 'Pair', 'Position', 'Strategy', 'Timeframe', 'PnL', 'R Factor', 'Confidence', 'Mood', 'Notes'];
      const e2 = v => {
        const s = String(v == null ? '' : v);
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
      };

      const lines = [
        headers.join(','),
        ...rows.map(t => [
          t.date, t.time, t.pair, t.position,
          (t.strategy || []).join(';'),
          (t.timeframe || []).join(';'),
          t.pnl, t.r, t.confidence,
          (t.mood || []).join(';'),
          t.notes
        ].map(e2).join(','))
      ];

      const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const fname = `${(journalObj.name || 'trades').replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;
      Object.assign(document.createElement('a'), { href: url, download: fname }).click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${rows.length} trades as CSV`, 'fa-solid fa-circle-check', 'green');
    } catch (e) {
      showToast('CSV export failed: ' + e.message, 'fa-solid fa-circle-exclamation', 'red');
    }
  }

  // Expose globally (called from rendered HTML)
  window.exportCSV = exportCSV;


  // ============================
  // JSON Export (with base64 images)
  // ============================

  function openExport() {
    exportScope = 'full';
    setScope('full');
    document.getElementById('exportOverlay').classList.add('open');
    refreshExpSummary();
  }

  function closeExport() {
    document.getElementById('exportOverlay').classList.remove('open');
  }

  function setScope(s) {
    exportScope = s;
    ['full', 'trades'].forEach(k => {
      const o = document.getElementById('scope' + (k === 'full' ? 'Full' : 'Trades'));
      const a = k === s;
      o.classList.toggle('active', a);
      o.querySelector('.sco-chk').innerHTML = a
        ? '<i class="fa-solid fa-circle-check"></i>'
        : '<i class="fa-regular fa-circle"></i>';
    });
    refreshExpSummary();
  }

  async function refreshExpSummary() {
    const el = document.getElementById('exportSummary');
    el.innerHTML = '<div class="es-row"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';
    const trades = await getTrades(journalId);
    const s = settings || {};
    const f = exportScope === 'full';
    const withImgs = trades.filter(t => t.images && t.images.length > 0).length;
    el.innerHTML = `
      <div class="es-row ok"><i class="fa-solid fa-check"></i> ${trades.length} trade${trades.length !== 1 ? 's' : ''}</div>
      <div class="es-row ${f ? 'ok' : ''}"><i class="fa-solid fa-${f ? 'check' : 'xmark'}"></i> ${(s.strategies || []).length} strategy tags</div>
      <div class="es-row ${f ? 'ok' : ''}"><i class="fa-solid fa-${f ? 'check' : 'xmark'}"></i> ${(s.moods || []).length} mood tags</div>
      <div class="es-row ${f ? 'ok' : ''}"><i class="fa-solid fa-${f ? 'check' : 'xmark'}"></i> Capital &amp; name</div>
      <div class="es-row ${f ? 'ok' : ''}"><i class="fa-solid fa-${f ? 'images' : 'xmark'}"></i> ${withImgs} trade${withImgs !== 1 ? 's' : ''} with images${f ? ' (embedded in backup)' : ' (not included)'}</div>
    `;
  }

  /**
   * Fetch an image URL and convert it to a base64 data URL.
   * Returns null if the fetch fails (don't abort the whole export).
   */
  async function urlToBase64(url) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return await new Promise(res => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => res(null);
        r.readAsDataURL(blob);
      });
    } catch { return null; }
  }

  async function confirmExport() {
    const btn = document.getElementById('exportBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Preparing…';

    try {
      const trades = await getTrades(journalId);
      const isFull = exportScope === 'full';
      const tradeRows = trades.map(dbToTrade);

      // Embed images as base64 when doing a full backup
      if (isFull) {
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Embedding images…';
        for (let i = 0; i < tradeRows.length; i++) {
          const t = tradeRows[i];
          if (t.images && t.images.length > 0) {
            const b64Imgs = [];
            for (const imgUrl of t.images) {
              if (typeof imgUrl === 'string' && imgUrl.startsWith('data:')) {
                b64Imgs.push(imgUrl);
              } else if (typeof imgUrl === 'string' && imgUrl.startsWith('http')) {
                const b64 = await urlToBase64(imgUrl);
                b64Imgs.push(b64 || imgUrl);
              } else {
                b64Imgs.push(imgUrl);
              }
            }
            tradeRows[i] = { ...t, images: b64Imgs };
          }
        }
      }

      const payload = {
        _meta: {
          version: '2.1', app: 'TradeZona', journalName: journalObj.name,
          exportedAt: new Date().toISOString(), exportScope,
          tradeCount: trades.length, imagesEmbedded: isFull,
        },
        trades: tradeRows,
        ...(isFull && settings ? {
          settings: {
            strategies: settings.strategies || [],
            timeframes: settings.timeframes || [],
            pairs: settings.pairs || [],
            moods: settings.moods || [],
            mood_colors: settings.mood_colors || {},
            capital: journalObj.capital,
            journalName: journalObj.name
          }
        } : {})
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const fname = `${journalObj.name.replace(/[^a-z0-9]/gi, '_')}_${exportScope}_${new Date().toISOString().slice(0, 10)}.json`;
      Object.assign(document.createElement('a'), { href: url, download: fname }).click();
      URL.revokeObjectURL(url);
      closeExport();
      showToast(`Exported ${trades.length} trades${isFull ? ' with images' : ''}!`, 'fa-solid fa-circle-check', 'green');
    } catch (e) {
      showToast('Export failed: ' + e.message, 'fa-solid fa-circle-exclamation', 'red');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-download"></i>Download .json';
    }
  }

  // Expose globally (called from HTML onclick / rendered HTML)
  window.openExport = openExport;
  window.closeExport = closeExport;
  window.setScope = setScope;
  window.confirmExport = confirmExport;


  // ============================
  // JSON Import (with base64 image restore)
  // ============================

  function openImport() {
    importPayload = null;
    clearFile();
    setImpMode('replace');
    ['previewBox', 'settingsRestoreRow', 'importProgress'].forEach(id =>
      document.getElementById(id).classList.remove('show')
    );
    document.getElementById('importConfirmBtn').disabled = true;
    document.getElementById('importOverlay').classList.add('open');
  }

  function closeImport() {
    document.getElementById('importOverlay').classList.remove('open');
  }

  function setImpMode(m) {
    importMode = m;
    document.getElementById('modeReplace').classList.toggle('active', m === 'replace');
    document.getElementById('modeMerge').classList.toggle('active', m === 'merge');
    if (importPayload) refreshImpPreview();
  }

  function dzOver(e) {
    e.preventDefault();
    document.getElementById('importDZ').classList.add('over');
  }

  function dzLeave() {
    document.getElementById('importDZ').classList.remove('over');
  }

  function dzDrop(e) {
    e.preventDefault();
    dzLeave();
    const f = e.dataTransfer.files[0];
    if (f) loadImpFile(f);
  }

  function onFileSelect(e) {
    const f = e.target.files[0];
    if (f) loadImpFile(f);
  }

  function clearFile() {
    importPayload = null;
    document.getElementById('fileBadge').classList.remove('show');
    document.getElementById('fileNameLabel').textContent = '—';
    document.getElementById('previewBox').classList.remove('show');
    document.getElementById('settingsRestoreRow').classList.remove('show');
    document.getElementById('importFile').value = '';
    document.getElementById('importConfirmBtn').disabled = true;
  }

  function loadImpFile(file) {
    const r = new FileReader();
    r.onload = e => {
      try {
        const p = JSON.parse(e.target.result);
        importPayload = Array.isArray(p)
          ? { _meta: { journalName: 'Unknown', tradeCount: p.length }, trades: p }
          : (p.trades && Array.isArray(p.trades) ? p : null);
        if (!importPayload) { showToast('Invalid file.', 'fa-solid fa-circle-exclamation', 'red'); return; }
        document.getElementById('fileNameLabel').textContent = file.name;
        document.getElementById('fileBadge').classList.add('show');
        refreshImpPreview();
        document.getElementById('importConfirmBtn').disabled = false;
      } catch {
        showToast('Could not parse file.', 'fa-solid fa-circle-exclamation', 'red');
      }
    };
    r.readAsText(file);
  }

  async function refreshImpPreview() {
    if (!importPayload) return;
    document.getElementById('previewBox').classList.add('show');
    const inc = importPayload.trades || [];
    const cur = await getTrades(journalId);
    const curIds = new Set(cur.map(t => t.id));
    const dups = inc.filter(t => curIds.has(t.id)).length;
    const hasS = !!(importPayload.settings);
    const withImgs = inc.filter(t => t.images && t.images.some(img => typeof img === 'string' && img.startsWith('data:'))).length;

    document.getElementById('pvTotal').textContent = inc.length;
    document.getElementById('pvJournal').textContent = importPayload._meta?.journalName || '—';
    document.getElementById('pvHasSettings').textContent = hasS ? 'Yes' : 'No';
    document.getElementById('pvHasImages').textContent = withImgs > 0 ? `Yes (${withImgs} trades)` : 'No';
    document.getElementById('pvHasImages').className = 'pv-val ' + (withImgs > 0 ? 'pv-ok' : 'pv-info');

    if (importMode === 'merge') {
      document.getElementById('pvNewRow').style.display = '';
      document.getElementById('pvDupRow').style.display = dups > 0 ? '' : 'none';
      document.getElementById('pvCurRow').style.display = 'none';
      document.getElementById('pvNew').textContent = inc.length - dups;
      document.getElementById('pvDup').textContent = dups;
    } else {
      document.getElementById('pvNewRow').style.display = 'none';
      document.getElementById('pvDupRow').style.display = 'none';
      document.getElementById('pvCurRow').style.display = '';
      document.getElementById('pvCur').textContent = cur.length;
    }

    document.getElementById('settingsRestoreRow').classList.toggle('show', hasS);
  }

  async function confirmImport() {
    if (!importPayload) return;
    const cb = document.getElementById('importConfirmBtn');
    const cancel = document.getElementById('importCancelBtn');
    cb.disabled = true;
    cancel.disabled = true;
    document.getElementById('importProgress').classList.add('show');

    const sp = (p, l) => {
      document.getElementById('impProgBar').style.width = p + '%';
      document.getElementById('impProgSub').textContent = l;
    };

    try {
      const inc = importPayload.trades || [];
      const cur = await getTrades(journalId);
      const curIds = new Set(cur.map(t => t.id));
      let fc = 0;

      if (importMode === 'replace') {
        document.getElementById('impProgLabel').textContent = 'Deleting…';
        for (let i = 0; i < cur.length; i++) {
          await deleteTrade(cur[i].id);
          sp(5 + Math.round((i + 1) / cur.length * 35), `${i + 1}/${cur.length}`);
        }
        document.getElementById('impProgLabel').textContent = 'Importing…';
        for (let i = 0; i < inc.length; i++) {
          const { id: _, ...d } = inc[i];
          await createTrade(currentUser.id, journalId, d);
          fc++;
          sp(40 + Math.round((i + 1) / inc.length * 50), `${i + 1}/${inc.length}`);
        }
      } else {
        const nt = inc.filter(t => !curIds.has(t.id));
        document.getElementById('impProgLabel').textContent = 'Merging…';
        for (let i = 0; i < nt.length; i++) {
          const { id: _, ...d } = nt[i];
          await createTrade(currentUser.id, journalId, d);
          fc++;
          sp(10 + Math.round((i + 1) / nt.length * 80), `${i + 1}/${nt.length}`);
        }
        fc = cur.length + nt.length;
      }

      const hasS = !!(importPayload.settings);
      const shouldRestore = hasS && document.getElementById('restoreSettingsChk')?.checked;

      if (shouldRestore) {
        sp(95, 'Restoring settings…');
        const s = importPayload.settings;
        const su = {};
        if (s.strategies) su.strategies = s.strategies;
        if (s.timeframes) su.timeframes = s.timeframes;
        if (s.pairs) su.pairs = s.pairs;
        if (s.moods) su.moods = s.moods;
        if (s.mood_colors) su.mood_colors = s.mood_colors;
        await updateJournalSettings(journalId, su);
        settings = { ...settings, ...su };
        const ju = {};
        if (s.capital) ju.capital = s.capital;
        if (s.journalName) ju.name = s.journalName;
        if (Object.keys(ju).length) {
          await updateJournal(journalId, ju);
          Object.assign(journalObj, ju);
          if (s.journalName) {
            document.getElementById('jnameHdr').textContent = s.journalName;
            document.title = 'TradeZona — ' + s.journalName;
          }
        }
      }

      sp(100, 'Done!');
      await new Promise(r => setTimeout(r, 600));
      closeImport();
      document.getElementById('logsFrame').src = 'logs.html?t=' + Date.now();
      if (activeTab === 'settings') populateSettings();
      showToast(
        `Import complete — ${fc} trade${fc !== 1 ? 's' : ''}${shouldRestore ? ' + settings' : ''}!`,
        'fa-solid fa-circle-check', 'green'
      );
    } catch (e) {
      showToast('Import failed: ' + e.message, 'fa-solid fa-circle-exclamation', 'red');
      document.getElementById('importProgress').classList.remove('show');
      cb.disabled = false;
      cancel.disabled = false;
    }
  }

  // Expose globally (called from HTML onclick / rendered HTML)
  window.openImport = openImport;
  window.closeImport = closeImport;
  window.setImpMode = setImpMode;
  window.dzOver = dzOver;
  window.dzLeave = dzLeave;
  window.dzDrop = dzDrop;
  window.onFileSelect = onFileSelect;
  window.clearFile = clearFile;
  window.confirmImport = confirmImport;


  // ============================
  // Delete Journal
  // ============================

  function openDelJournal() {
    document.getElementById('delJournalName').textContent = journalObj?.name || 'this journal';
    document.getElementById('delConfirmInput').value = '';
    checkDel();
    document.getElementById('delOverlay').classList.add('open');
    setTimeout(() => document.getElementById('delConfirmInput').focus(), 120);
  }

  function closeDelJournal() {
    document.getElementById('delOverlay').classList.remove('open');
  }

  function checkDel() {
    const exp = (journalObj?.name || '').trim().toLowerCase();
    const typ = document.getElementById('delConfirmInput').value.trim().toLowerCase();
    const ok = typ === exp && exp !== '';
    const btn = document.getElementById('delConfirmBtn');
    btn.disabled = !ok;
    btn.style.opacity = ok ? '1' : '.4';
    btn.style.cursor = ok ? 'pointer' : 'not-allowed';
  }

  async function executeDelete() {
    try {
      await deleteJournal(journalId);
      sessionStorage.removeItem('tz_current_journal');
      location.href = '/dashboard';
    } catch (e) {
      showToast('Error: ' + e.message, 'fa-solid fa-circle-exclamation', 'red');
    }
  }

  // Expose globally (called from HTML onclick)
  window.openDelJournal = openDelJournal;
  window.closeDelJournal = closeDelJournal;
  window.checkDel = checkDel;
  window.executeDelete = executeDelete;


  // ============================
  // Modal Overlay Click-to-Close
  // ============================

  ['delOverlay', 'exportOverlay', 'importOverlay'].forEach(id => {
    document.getElementById(id).addEventListener('click', function (e) {
      if (e.target === this) {
        if (id === 'delOverlay') closeDelJournal();
        if (id === 'exportOverlay') closeExport();
        if (id === 'importOverlay') closeImport();
      }
    });
  });


  // ============================
  // Analytics Bar Toggle
  // ============================

  function toggleAnalyticsBar() {
    const cur = localStorage.getItem('tl_analytics_on') !== 'false';
    const next = !cur;
    localStorage.setItem('tl_analytics_on', next);
    const sw = document.getElementById('analyticsToggleSwitch');
    if (sw) sw.classList.toggle('on', next);
    bcast({ type: 'tz_analytics_toggle', on: next });
  }

  // Expose globally (called from HTML onclick)
  window.toggleAnalyticsBar = toggleAnalyticsBar;


  // ============================
  // Toast Notification
  // ============================

  function showToast(msg, icon = 'fa-solid fa-circle-check', type = '') {
    const t = document.getElementById('toast');
    document.getElementById('toastIcon').className = icon;
    document.getElementById('toastMsg').innerHTML = msg;
    t.className = 'show' + (type === 'green' ? ' toast-green' : type === 'red' ? ' toast-red' : '');
    clearTimeout(_tt);
    _tt = setTimeout(() => { t.classList.remove('show', 'toast-green', 'toast-red'); }, 3500);
  }


  // ============================
  // Utility
  // ============================

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }


  // ============================
  // Event Listeners
  // ============================

  // Header: back button
  document.querySelector('.back-btn').addEventListener('click', goBack);

  // Nav tabs
  document.querySelectorAll('.tab[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Settings: journal name input
  document.getElementById('js-name').addEventListener('input', markDirty);

  // Settings: capital input
  document.getElementById('js-capital').addEventListener('input', markDirty);

  // Settings: save button
  document.querySelector('.jsave-btn').addEventListener('click', saveJournalSettings);

  // Settings: show PNL toggle
  document.getElementById('showPnlToggle').addEventListener('click', () => toggleFlag('show_pnl'));

  // Settings: show capital toggle
  document.getElementById('showCapToggle').addEventListener('click', () => toggleFlag('show_capital'));

  // Settings: analytics bar toggle
  document.getElementById('analyticsToggleSwitch').addEventListener('click', toggleAnalyticsBar);

  // Settings: add strategy tag
  document.querySelector('[onclick="addTag(\'strategies\',\'stratInput\')"]')
    ?.addEventListener('click', () => addTag('strategies', 'stratInput'));

  // Settings: add timeframe tag
  document.querySelector('[onclick="addTag(\'timeframes\',\'tfInput\')"]')
    ?.addEventListener('click', () => addTag('timeframes', 'tfInput'));

  // Settings: add pair tag
  document.querySelector('[onclick="addTag(\'pairs\',\'pairInput\')"]')
    ?.addEventListener('click', () => addTag('pairs', 'pairInput'));

  // Settings: add mood tag
  document.querySelector('[onclick="addMoodTag()"]')
    ?.addEventListener('click', addMoodTag);

  // Unsaved bar: discard
  document.querySelector('.btn-discard').addEventListener('click', discardChanges);

  // Unsaved bar: save now
  document.querySelector('.btn-save-now').addEventListener('click', saveJournalSettings);

  // Export modal: close
  document.querySelector('#exportOverlay .mclose').addEventListener('click', closeExport);
  document.querySelector('#exportOverlay .btn-ghost').addEventListener('click', closeExport);
  document.getElementById('exportBtn').addEventListener('click', confirmExport);

  // Export scope options
  document.getElementById('scopeFull').addEventListener('click', () => setScope('full'));
  document.getElementById('scopeTrades').addEventListener('click', () => setScope('trades'));

  // Import modal: close
  document.querySelector('#importOverlay .mclose').addEventListener('click', closeImport);
  document.getElementById('importCancelBtn').addEventListener('click', closeImport);
  document.getElementById('importConfirmBtn').addEventListener('click', confirmImport);

  // Import: drag and drop
  document.getElementById('importDZ').addEventListener('dragover', dzOver);
  document.getElementById('importDZ').addEventListener('dragleave', dzLeave);
  document.getElementById('importDZ').addEventListener('drop', dzDrop);

  // Import: file select
  document.getElementById('importFile').addEventListener('change', onFileSelect);

  // Import: clear file
  document.querySelector('.file-badge .clr').addEventListener('click', clearFile);

  // Import mode options
  document.getElementById('modeReplace').addEventListener('click', () => setImpMode('replace'));
  document.getElementById('modeMerge').addEventListener('click', () => setImpMode('merge'));

  // Delete journal: open
  document.querySelector('.btn-danger').addEventListener('click', openDelJournal);

  // Delete journal: confirm input
  document.getElementById('delConfirmInput').addEventListener('input', checkDel);

  // Delete journal: cancel / confirm buttons
  document.querySelector('#delOverlay [onclick="closeDelJournal()"]')
    ?.addEventListener('click', closeDelJournal);
  document.getElementById('delConfirmBtn').addEventListener('click', executeDelete);

  // PIN inputs
  document.getElementById('pinNew').addEventListener('input', onPinInput);
  document.getElementById('pinConfirm').addEventListener('input', onPinInput);

  // Enter key shortcuts for tag inputs
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const a = document.activeElement;
    if (a.id === 'stratInput') addTag('strategies', 'stratInput');
    if (a.id === 'tfInput') addTag('timeframes', 'tfInput');
    if (a.id === 'pairInput') addTag('pairs', 'pairInput');
    if (a.id === 'moodInput') addMoodTag();
  });

  // Unsaved changes: warn before unload
  window.addEventListener('beforeunload', e => {
    if (activeTab === 'settings' && isDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Postmessage listener (iframe communication)
  window.addEventListener('message', e => {
    if (e.data?.type === 'tz_flushed' && _flushTarget) {
      clearTimeout(_flushTimer);
      const d = _flushTarget;
      _flushTarget = null;
      location.href = d;
    }
    if (e.data?.type === 'tz_analytics_state') {
      const sw = document.getElementById('analyticsToggleSwitch');
      if (sw) sw.classList.toggle('on', !!e.data.on);
    }
  });


  // ============================
  // Calculator — FAB + Draggable Modal
  // ============================

  function toggleCalc() {
    _calcOpen = !_calcOpen;
    const modal = document.getElementById('calcModal');
    const fab = document.getElementById('calcFab');
    const icon = document.getElementById('calcFabIcon');

    if (_calcOpen) {
      modal.classList.add('open');
      fab.classList.add('open');
      icon.className = 'fa-solid fa-xmark';
      if (!modal._placed) {
        modal.style.right = '16px';
        modal.style.bottom = '82px';
        modal.style.top = 'auto';
        modal.style.left = 'auto';
        modal.style.width = 'min(700px,96vw)';
        modal._placed = true;
      }
      cCalc();
    } else {
      modal.classList.remove('open');
      fab.classList.remove('open');
      icon.className = 'fa-solid fa-calculator';
    }
  }

  // Expose globally (called from HTML onclick)
  window.toggleCalc = toggleCalc;

  document.getElementById('calcFab').addEventListener('click', toggleCalc);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _calcOpen) toggleCalc();
  });

  document.querySelector('.calc-x').addEventListener('click', toggleCalc);


  // ============================
  // Calculator — Asset Toggle
  // ============================

  function cSetAsset(t) {
    _cAsset = t;
    document.getElementById('cBtnCrypto').classList.toggle('active', t === 'crypto');
    document.getElementById('cBtnForex').classList.toggle('active', t === 'forex');
    const fp = document.getElementById('cForexPairField');
    if (fp) fp.classList.toggle('show', t === 'forex');
    cCalc();
  }

  // Expose globally (called from HTML onclick)
  window.cSetAsset = cSetAsset;

  document.getElementById('cBtnCrypto').addEventListener('click', () => cSetAsset('crypto'));
  document.getElementById('cBtnForex').addEventListener('click', () => cSetAsset('forex'));


  // ============================
  // Calculator — Core Logic
  // ============================

  function _g(id) { return document.getElementById(id)?.value; }
  function _s(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
  function _fD(n) {
    if (n === null || isNaN(n)) return '—';
    return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function _f(n, d = 2) {
    if (n === null || isNaN(n)) return '—';
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function cCalc() {
    const bal = parseFloat(_g('cBalance'));
    const rp = parseFloat(_g('cRiskPct'));
    const ent = parseFloat(_g('cEntry'));
    const sl = parseFloat(_g('cSL'));
    const tp = parseFloat(_g('cTP'));
    const pair = _g('cPair') || 'EURUSD';

    const riskAmt = (!isNaN(bal) && !isNaN(rp) && bal > 0 && rp > 0) ? bal * (rp / 100) : null;
    _s('cRiskAmt', riskAmt !== null ? _fD(riskAmt) : '—');
    _s('cRiskPctLbl', (!isNaN(rp) && rp > 0) ? rp.toFixed(1) + '% of balance' : '—');

    if (riskAmt === null || isNaN(ent) || isNaN(sl) || ent === sl || ent <= 0 || sl <= 0) { _cClear(); return; }
    const dist = Math.abs(ent - sl);
    if (!dist) { _cClear(); return; }

    const isJPY = pair.includes('JPY');
    const isSp = ['XAUUSD', 'US30', 'NAS100'].includes(pair);

    let pos, unit, sldStr, sldUnit, maxL, profit = null, rr = null, formula;

    if (_cAsset === 'crypto') {
      pos = riskAmt / dist;
      maxL = pos * dist;
      unit = 'units';
      sldStr = _f(dist, dist < 1 ? 6 : 2);
      sldUnit = 'price diff';
      formula = `${_fD(riskAmt)} ÷ ${sldStr} = ${_f(pos, 6)} units`;
      if (!isNaN(tp) && tp > 0 && tp !== ent) { const d = Math.abs(tp - ent); profit = pos * d; rr = profit / riskAmt; }
    } else if (isSp) {
      pos = riskAmt / dist;
      maxL = riskAmt;
      unit = pair === 'XAUUSD' ? 'oz' : 'contracts';
      sldStr = _f(dist, 2);
      sldUnit = 'price dist';
      formula = `${_fD(riskAmt)} ÷ ${sldStr} = ${_f(pos, 4)} ${unit}`;
      if (!isNaN(tp) && tp > 0 && tp !== ent) { const d = Math.abs(tp - ent); profit = pos * d; rr = profit / riskAmt; }
    } else {
      const mult = isJPY ? 100 : 10000, pips = dist * mult, pipVal = 10;
      pos = riskAmt / (pips * pipVal);
      maxL = pos * pips * pipVal;
      unit = 'std lots';
      sldStr = _f(pips, 1);
      sldUnit = 'pips';
      formula = `${_f(pips, 1)} pips × $${pipVal}/pip → ${_f(pos, 4)} lots`;
      if (!isNaN(tp) && tp > 0 && tp !== ent) { const tpP = Math.abs(tp - ent) * mult; profit = pos * tpP * pipVal; rr = profit / riskAmt; }
    }

    _s('cPosSize', _f(pos, pos < 0.001 ? 6 : pos < 1 ? 4 : 2));
    _s('cPosUnit', unit);
    _s('cSLDist', sldStr);
    _s('cSLUnit', sldUnit);
    _s('cMaxLoss', _fD(maxL));
    _s('cFormula', formula);

    const pnlSec = document.getElementById('cPnlSec');
    if (profit !== null) {
      pnlSec.style.display = 'block';
      _s('cLoss2', _fD(riskAmt));
      _s('cProfit', _fD(profit));
      const rrSec = document.getElementById('cRRSec');
      if (rr !== null) {
        rrSec.style.display = 'block';
        const col = rr >= 3 ? 'var(--accent)' : rr >= 2 ? 'var(--accent2)' : rr >= 1 ? 'var(--amber)' : 'var(--red)';
        const rrEl = document.getElementById('cRR');
        rrEl.textContent = '1 : ' + _f(rr, 2);
        rrEl.style.color = col;
        const bar = document.getElementById('cRRBar');
        bar.style.width = Math.min((rr / 3) * 100, 100) + '%';
        bar.style.background = col;
      } else {
        rrSec.style.display = 'none';
      }
    } else {
      pnlSec.style.display = 'none';
    }
  }

  function _cClear() {
    ['cPosSize', 'cPosUnit', 'cSLDist', 'cSLUnit', 'cMaxLoss'].forEach(k => _s(k, '—'));
    const p = document.getElementById('cPnlSec');
    if (p) p.style.display = 'none';
    _s('cFormula', 'Position = Risk ÷ SL Distance');
  }

  // Expose cCalc globally (called from HTML oninput)
  window.cCalc = cCalc;

  // Calculator input listeners
  ['cBalance', 'cRiskPct', 'cEntry', 'cSL', 'cTP'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', cCalc);
  });
  document.getElementById('cPair')?.addEventListener('change', cCalc);


  // ============================
  // Calculator — Drag Logic
  // ============================

  (function () {
    const modal = document.getElementById('calcModal');
    const hdr = document.getElementById('calcDragHdr');
    let drag = false, ox = 0, oy = 0;

    hdr.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.target.closest('.calc-x')) return;
      drag = true;
      const r = modal.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      modal.style.right = 'auto';
      modal.style.bottom = 'auto';
      modal.style.left = r.left + 'px';
      modal.style.top = r.top + 'px';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!drag) return;
      const nx = Math.max(0, Math.min(e.clientX - ox, window.innerWidth - modal.offsetWidth));
      const ny = Math.max(0, Math.min(e.clientY - oy, window.innerHeight - modal.offsetHeight));
      modal.style.left = nx + 'px';
      modal.style.top = ny + 'px';
    });

    document.addEventListener('mouseup', () => {
      drag = false;
      document.body.style.userSelect = '';
    });

    hdr.addEventListener('touchstart', e => {
      if (e.target.closest('.calc-x')) return;
      const r = modal.getBoundingClientRect();
      ox = e.touches[0].clientX - r.left;
      oy = e.touches[0].clientY - r.top;
      modal.style.right = 'auto';
      modal.style.bottom = 'auto';
      modal.style.left = r.left + 'px';
      modal.style.top = r.top + 'px';
      drag = true;
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('touchmove', e => {
      if (!drag) return;
      const nx = Math.max(0, Math.min(e.touches[0].clientX - ox, window.innerWidth - modal.offsetWidth));
      const ny = Math.max(0, Math.min(e.touches[0].clientY - oy, window.innerHeight - modal.offsetHeight));
      modal.style.left = nx + 'px';
      modal.style.top = ny + 'px';
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('touchend', () => { drag = false; });
  })();

}); // end DOMContentLoaded