// presession.js — simplified daily planner

window.addEventListener('message', e => {
  if (e.data?.type === 'tz_plan' && e.data.isPro !== undefined) userIsPro = e.data.isPro;
});

const jid = sessionStorage.getItem('tz_current_journal')
  || localStorage.getItem('tz_current_journal')
  || (()=>{ try { return parent?.sessionStorage?.getItem('tz_current_journal') || parent?.localStorage?.getItem('tz_current_journal'); } catch(e){return null;} })();

// ─── Globals ────────────────────────────────────────────────────────────────
let currentUser = null, settings = null, userIsPro = false;
let sessionData = null;          // today's presession record from DB
let currentDate = todayLocal();  // YYYY-MM-DD
let isToday = true;
let isDirty = false;
let activeTab = 'today';
let saveDebounce = null;

// In-memory session state (synced to DB on save)
let bias = '';
let marketNotes = '';
let newsEvents = [];   // [{id, label, checked}]
let rulesChecked = new Set(); // IDs of checked rules
let checklistChecks = new Set(); // IDs of checked checklist items
let reflectMood = '';
let reflectWell = '', reflectWrong = '', reflectLesson = '', tomorrowFocus = '';

// Settings-level data (permanent)
let tradeRules = [];      // [{id, text}]
let checklistItems = [];  // [{id, text}]

// Default news presets
const DEFAULT_NEWS = ['NFP', 'CPI', 'FOMC', 'ECB Rate', 'BOE Rate'];
const MOODS = ['😊 Calm', '🎯 Focused', '😤 Frustrated', '😰 Anxious', '🤑 Greedy', '😴 Tired', '💪 Confident'];

function todayLocal() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function esc(s) { const d = document.createElement('div'); d.textContent = String(s||''); return d.innerHTML; }
function uid() { return 'r' + Math.random().toString(36).slice(2,9); }

// ─── Init ────────────────────────────────────────────────────────────────────
(async () => {
  if (!jid) { document.body.style.visibility = 'visible'; showToast('No journal selected.','fa-solid fa-triangle-exclamation','r'); return; }
  try { userIsPro = parent?._userIsPro || false; } catch(e) {}
  const { data: { user } } = await db.auth.getUser();
  currentUser = user;
  if (user) { const p = await getProfile(user.id); if (p) userIsPro = p.plan === 'pro'; }
  settings = await getJournalSettings(jid);
  tradeRules = settings?.trade_rules || [];
  checklistItems = settings?.checklist_items || [];
  await loadSession(currentDate);
  document.body.style.visibility = 'visible';
  try { parent.postMessage({ type: 'tz_presession_summary', date: currentDate, bias, checklist_score: checkProgress(), active_intents: [] }, '*'); } catch(e) {}
})();

// ─── Session load/save ───────────────────────────────────────────────────────
async function loadSession(date) {
  currentDate = date;
  isToday = date === todayLocal();
  updateReadonlyUI();

  // Fetch from DB
  try {
    const { data, error } = await db.from('presessions')
      .select('*').eq('journal_id', jid).eq('session_date', date).maybeSingle();
    sessionData = data || null;
  } catch(e) { sessionData = null; }

  // Populate state
  bias = sessionData?.bias || '';
  marketNotes = sessionData?.market_notes || '';
  newsEvents = sessionData?.news_events || DEFAULT_NEWS.map(label => ({ id: uid(), label, checked: false }));
  rulesChecked = new Set(sessionData?.rules_checked || []);
  checklistChecks = new Set(sessionData?.checklist_checks || []);
  reflectMood = sessionData?.reflect_mood || '';
  reflectWell = sessionData?.reflect_well || '';
  reflectWrong = sessionData?.reflect_wrong || '';
  reflectLesson = sessionData?.reflect_lesson || '';
  tomorrowFocus = sessionData?.tomorrow_focus || '';
  isDirty = false;

  renderAll();
  updateBanner();
}

async function upsertSession(updates) {
  if (!currentUser) return;
  try {
    const { error } = await db.from('presessions').upsert({
      user_id: currentUser.id,
      journal_id: jid,
      session_date: currentDate,
      ...updates,
      updated_at: new Date().toISOString()
    }, { onConflict: 'journal_id,session_date' });
    if (error) throw error;
  } catch(e) { throw e; }
}

async function saveSettingsData() {
  await updateJournalSettings(jid, { trade_rules: tradeRules, checklist_items: checklistItems });
  settings = await getJournalSettings(jid);
}

// ─── Date navigation ─────────────────────────────────────────────────────────
function navSession(dir) {
  const d = new Date(currentDate + 'T00:00:00');
  d.setDate(d.getDate() + dir);
  const nd = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  if (nd > todayLocal()) return; // can't go to future
  loadSession(nd);
}
function goToday() { loadSession(todayLocal()); }

function updateReadonlyUI() {
  const bar = document.getElementById('psReadonlyBar');
  const saveButtons = document.querySelectorAll('.btn-ps-save');
  if (isToday) {
    bar.style.display = 'none';
    saveButtons.forEach(b => b.disabled = false);
  } else {
    bar.style.display = 'flex';
    document.getElementById('psReadonlyDate').textContent = currentDate;
    saveButtons.forEach(b => b.disabled = true);
  }
  // Header
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(currentDate + 'T00:00:00');
  document.getElementById('psDateTitle').textContent = isToday ? 'Pre-Session' : `Pre-Session — ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  document.getElementById('psSubtitle').textContent = isToday
    ? `Today — ${new Date().toLocaleDateString('en-US',{weekday:'long'})}`
    : `Past session — read only`;
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function switchPsTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.ps-tab').forEach(b => b.classList.toggle('active', b.dataset.pstab === tab));
  document.querySelectorAll('.ps-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
}

// ─── Render all ──────────────────────────────────────────────────────────────
function renderAll() {
  renderBiasSelector();
  document.getElementById('marketNotes').value = marketNotes;
  renderNewsList();
  renderRulesCL();
  renderChecklistTab();
  renderReflect();
  updateProgress();
  setDirtyIndicator(false);
}

// ─── Bias ─────────────────────────────────────────────────────────────────────
function renderBiasSelector() {
  document.querySelectorAll('.bias-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.bias === bias);
  });
}
function setBias(val) {
  if (!isToday) return;
  bias = bias === val ? '' : val;
  renderBiasSelector();
  markDirty();
  updateBanner();
}

// ─── Banner ───────────────────────────────────────────────────────────────────
function updateBanner() {
  const biasEl = document.getElementById('sbBias');
  const dotEl = document.getElementById('sbDot');
  const phaseEl = document.getElementById('sbPhase');
  const scoreEl = document.getElementById('sbScoreVal');
  biasEl.textContent = bias || '—';
  dotEl.className = 'sb-dot ' + ({Bullish:'bull',Bearish:'bear',Neutral:'neut',Wait:'wait'}[bias]||'');
  const checked = rulesChecked.size, total = tradeRules.length;
  scoreEl.textContent = total ? `${checked}/${total}` : '—';
  phaseEl.textContent = isToday ? 'Today' : currentDate;
}

// ─── News ─────────────────────────────────────────────────────────────────────
function renderNewsList() {
  const list = document.getElementById('newsList');
  if (!newsEvents.length) { list.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:4px 0">No news events added.</div>'; return; }
  list.innerHTML = '';
  newsEvents.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'news-item';
    div.innerHTML = `
      <input type="checkbox" class="news-cb" ${item.checked?'checked':''} ${isToday?'':'disabled'} onchange="toggleNews('${item.id}',this.checked)">
      <span class="news-label${item.checked?' checked':''}">${esc(item.label)}</span>
      ${isToday?`<button class="news-del" onclick="deleteNews('${item.id}')"><i class="fa-solid fa-xmark"></i></button>`:''}
    `;
    list.appendChild(div);
  });
}
function addNews() {
  if (!isToday) return;
  const inp = document.getElementById('newsInp');
  const val = inp.value.trim(); if (!val) return;
  newsEvents.push({ id: uid(), label: val, checked: false });
  inp.value = '';
  renderNewsList();
  markDirty();
}
function toggleNews(id, checked) {
  const item = newsEvents.find(n => n.id === id);
  if (item) { item.checked = checked; renderNewsList(); markDirty(); }
}
function deleteNews(id) {
  newsEvents = newsEvents.filter(n => n.id !== id);
  renderNewsList(); markDirty();
}

// ─── Trade Rules ──────────────────────────────────────────────────────────────
function renderRulesCL() {
  const list = document.getElementById('rulesCLList');
  if (!tradeRules.length) { list.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:4px 0">No rules yet. Add your trading rules below.</div>'; return; }
  list.innerHTML = '';
  tradeRules.forEach(rule => {
    const isChecked = rulesChecked.has(rule.id);
    const div = document.createElement('div');
    div.className = 'rule-cl-item' + (isChecked ? ' checked-rule' : '');
    div.innerHTML = `
      <input type="checkbox" class="rule-cb" ${isChecked?'checked':''} ${isToday?'':'disabled'} onchange="toggleRule('${rule.id}',this.checked)">
      <span class="rule-text${isChecked?' crossed':''}">${esc(rule.text)}</span>
      <button class="rule-del" onclick="deleteRule('${rule.id}')" title="Remove rule"><i class="fa-solid fa-xmark"></i></button>
    `;
    list.appendChild(div);
  });
  updateBanner();
}
function addRule() {
  const inp = document.getElementById('ruleInp');
  const val = inp.value.trim(); if (!val) return;
  tradeRules.push({ id: uid(), text: val });
  inp.value = '';
  renderRulesCL();
  markDirty();
  saveSettingsData().catch(e => showToast('Settings save failed.','fa-solid fa-triangle-exclamation','r'));
}
function deleteRule(id) {
  tradeRules = tradeRules.filter(r => r.id !== id);
  rulesChecked.delete(id);
  renderRulesCL();
  markDirty();
  saveSettingsData().catch(e => {});
}
function toggleRule(id, checked) {
  if (checked) rulesChecked.add(id); else rulesChecked.delete(id);
  renderRulesCL();
  markDirty();
}

// ─── Save today tab ───────────────────────────────────────────────────────────
async function saveTodayTab() {
  if (!isToday) return;
  marketNotes = document.getElementById('marketNotes').value;
  try {
    await upsertSession({
      bias,
      market_notes: marketNotes,
      news_events: newsEvents,
      rules_checked: [...rulesChecked]
    });
    setDirtyIndicator(false, 'today');
    showToast('Plan saved.','fa-solid fa-circle-check','g');
    updateBanner();
    postSummary();
  } catch(e) { showToast('Save failed: ' + e.message,'fa-solid fa-triangle-exclamation','r'); }
}

// ─── Checklist tab ────────────────────────────────────────────────────────────
function renderChecklistTab() {
  const container = document.getElementById('clSimpleItems');
  if (!checklistItems.length) {
    container.innerHTML = '<div style="font-size:13px;color:var(--muted);padding:12px 0;text-align:center">No checklist items yet. Add some below via Manage Items.</div>';
    updateProgress(); return;
  }
  container.innerHTML = '';
  checklistItems.forEach(item => {
    const isChecked = checklistChecks.has(item.id);
    const div = document.createElement('div');
    div.className = 'cl-item-row' + (isChecked ? ' cl-checked' : '');
    div.onclick = () => { if (!isToday) return; toggleChecklistItem(item.id); };
    div.innerHTML = `
      <div class="cl-item-cb">${isChecked ? '✓' : ''}</div>
      <span class="cl-item-text">${esc(item.text)}</span>
    `;
    container.appendChild(div);
  });
  updateProgress();
  renderManageList();

  // Update badge
  const total = checklistItems.length, checked = checklistChecks.size;
  const badge = document.getElementById('checklistBadge');
  if (checked > 0) { badge.textContent = `${checked}/${total}`; badge.style.display = 'inline-block'; }
  else { badge.style.display = 'none'; }
}
function toggleChecklistItem(id) {
  if (checklistChecks.has(id)) checklistChecks.delete(id); else checklistChecks.add(id);
  renderChecklistTab();
  markDirty();
}
function updateProgress() {
  const total = checklistItems.length, checked = checklistChecks.size;
  const pct = total ? (checked / total) * 100 : 0;
  document.getElementById('clProgressFill').style.width = pct + '%';
  document.getElementById('clProgressLabel').textContent = `${checked} / ${total} checked`;
}
function checkProgress() {
  if (!checklistItems.length) return 0;
  return Math.round((checklistChecks.size / checklistItems.length) * 100);
}
function toggleManage() {
  const body = document.getElementById('clManageBody');
  const chevron = document.getElementById('manageChevron');
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'flex';
  chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
  if (!isOpen) renderManageList();
}
function renderManageList() {
  const list = document.getElementById('clManageList');
  if (!checklistItems.length) { list.innerHTML = '<div style="font-size:12px;color:var(--muted)">No items yet.</div>'; return; }
  list.innerHTML = '';
  checklistItems.forEach(item => {
    const div = document.createElement('div');
    div.className = 'cl-manage-item';
    div.innerHTML = `<span class="cl-manage-text">${esc(item.text)}</span><button class="cl-manage-del" onclick="deleteClItem('${item.id}')"><i class="fa-solid fa-xmark"></i></button>`;
    list.appendChild(div);
  });
}
function addClItem() {
  const inp = document.getElementById('clItemInp');
  const val = inp.value.trim(); if (!val) return;
  checklistItems.push({ id: uid(), text: val });
  inp.value = '';
  renderChecklistTab();
  saveSettingsData().catch(e => {});
}
function deleteClItem(id) {
  checklistItems = checklistItems.filter(i => i.id !== id);
  checklistChecks.delete(id);
  renderChecklistTab();
  saveSettingsData().catch(e => {});
}
async function saveChecklistTab() {
  if (!isToday) return;
  try {
    await upsertSession({ checklist_checks: [...checklistChecks] });
    setDirtyIndicator(false, 'checklist');
    showToast('Checklist saved.','fa-solid fa-circle-check','g');
    postSummary();
  } catch(e) { showToast('Save failed: ' + e.message,'fa-solid fa-triangle-exclamation','r'); }
}

// ─── Reflect tab ──────────────────────────────────────────────────────────────
function renderReflect() {
  // Mood buttons
  const moodRow = document.getElementById('reflectMoodRow');
  moodRow.innerHTML = '';
  MOODS.forEach(m => {
    const btn = document.createElement('button');
    btn.className = 'mood-btn' + (reflectMood === m ? ' active' : '');
    if (reflectMood === m) btn.style.borderColor = 'var(--accent2)';
    btn.textContent = m;
    btn.onclick = () => { if (!isToday) return; reflectMood = reflectMood === m ? '' : m; renderReflect(); markDirty(); };
    moodRow.appendChild(btn);
  });
  document.getElementById('reflectWell').value = reflectWell;
  document.getElementById('reflectWrong').value = reflectWrong;
  document.getElementById('reflectLesson').value = reflectLesson;
  document.getElementById('tomorrowFocus').value = tomorrowFocus;
  // readonly
  ['reflectWell','reflectWrong','reflectLesson','tomorrowFocus'].forEach(id => {
    document.getElementById(id).readOnly = !isToday;
  });
}
async function saveReflectTab() {
  if (!isToday) return;
  reflectWell = document.getElementById('reflectWell').value;
  reflectWrong = document.getElementById('reflectWrong').value;
  reflectLesson = document.getElementById('reflectLesson').value;
  tomorrowFocus = document.getElementById('tomorrowFocus').value;
  try {
    await upsertSession({ reflect_mood: reflectMood, reflect_well: reflectWell, reflect_wrong: reflectWrong, reflect_lesson: reflectLesson, tomorrow_focus: tomorrowFocus });
    setDirtyIndicator(false, 'reflect');
    showToast('Reflection saved.','fa-solid fa-circle-check','g');
  } catch(e) { showToast('Save failed: ' + e.message,'fa-solid fa-triangle-exclamation','r'); }
}

// ─── Dirty state ──────────────────────────────────────────────────────────────
function markDirty() {
  isDirty = true;
  // show indicator for active tab
  const dirtyIds = { today: 'todayDirty', checklist: 'checklistDirty', reflect: 'reflectDirty' };
  const el = document.getElementById(dirtyIds[activeTab]);
  if (el) { el.innerHTML = '<i class="fa-solid fa-circle-dot" style="font-size:9px"></i> Unsaved changes'; }
}
function setDirtyIndicator(on, tab) {
  const dirtyIds = { today: 'todayDirty', checklist: 'checklistDirty', reflect: 'reflectDirty' };
  const key = tab || activeTab;
  const el = document.getElementById(dirtyIds[key]);
  if (el) el.innerHTML = on ? '<i class="fa-solid fa-circle-dot" style="font-size:9px"></i> Unsaved changes' : '';
}

// ─── Post summary to parent ───────────────────────────────────────────────────
function postSummary() {
  try {
    parent.postMessage({
      type: 'tz_presession_summary',
      date: currentDate,
      bias,
      checklist_score: checkProgress(),
      active_intents: []
    }, '*');
  } catch(e) {}
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let _tt;
function showToast(msg, icon='fa-solid fa-circle-check', cls='') {
  const t = document.getElementById('toast');
  document.getElementById('toastIcon').className = icon;
  document.getElementById('toastMsg').textContent = msg;
  t.className = 'show' + (cls ? ' ' + cls : '');
  clearTimeout(_tt);
  _tt = setTimeout(() => { t.className = ''; }, 3200);
}