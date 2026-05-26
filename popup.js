'use strict';

const API           = 'https://discord.com/api/v9';
const DISCORD_EPOCH = 1420070400000n;

// ── 상태 ─────────────────────────────────────────────────
let token         = null;
let allDMChannels = [];
let isMultiSelect = false;
let selectedMap   = new Map(); // channelId → { channel, user }
let pollTimer     = null;

// ── DOM ──────────────────────────────────────────────────
const statusChip      = document.getElementById('status-chip');
const dmSearch        = document.getElementById('dm-search');
const dmListEl        = document.getElementById('dm-list');
const multiselectBtn  = document.getElementById('multiselect-btn');
const sectionDm       = document.getElementById('section-dm');
const sectionExport   = document.getElementById('section-export');
const sectionProgress = document.getElementById('section-progress');
const selectedChip    = document.getElementById('selected-chip');
const selAvatar       = document.getElementById('sel-avatar');
const selName         = document.getElementById('sel-name');
const selSince        = document.getElementById('sel-since');
const btnDeselect     = document.getElementById('btn-deselect');
const selectedCount   = document.getElementById('selected-count');
const selCountText    = document.getElementById('sel-count-text');
const btnClearAll     = document.getElementById('btn-clear-all');
const dateToggle      = document.getElementById('date-toggle');
const dateRangeRow    = document.getElementById('date-range-row');
const dateAllLabel    = document.getElementById('date-all-label');
const dateFrom        = document.getElementById('date-from');
const dateTo          = document.getElementById('date-to');
const exportBtn       = document.getElementById('export-btn');
const batchStatus     = document.getElementById('batch-status');
const progressFill    = document.getElementById('progress-fill');
const progressText    = document.getElementById('progress-text');
const elapsedTimeEl   = document.getElementById('elapsed-time');
const cancelBtn       = document.getElementById('cancel-btn');
const errorBox        = document.getElementById('error-box');
const cryptoBtn       = document.getElementById('crypto-btn');
const cryptoModal     = document.getElementById('crypto-modal');
const modalClose      = document.getElementById('modal-close');

// ── 이벤트 ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
dmSearch.addEventListener('input', () => renderDMList(filterChannels(dmSearch.value)));
multiselectBtn.addEventListener('click', toggleMultiSelect);
btnDeselect.addEventListener('click', clearSelection);
btnClearAll.addEventListener('click', clearSelection);
exportBtn.addEventListener('click', runExport);
cancelBtn.addEventListener('click', cancelExport);
cryptoBtn.addEventListener('click', () => cryptoModal.classList.remove('hidden'));
modalClose.addEventListener('click', () => cryptoModal.classList.add('hidden'));
cryptoModal.addEventListener('click', e => { if (e.target === cryptoModal) cryptoModal.classList.add('hidden'); });

dateToggle.addEventListener('change', () => {
  const on = dateToggle.checked;
  dateRangeRow.classList.toggle('hidden', !on);
  dateAllLabel.classList.toggle('hidden', on);
  if (!on) { dateFrom.value = ''; dateTo.value = ''; }
});

document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const text = document.getElementById(btn.dataset.target)?.textContent.trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = '✓'; btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '복사'; btn.classList.remove('copied'); }, 2000);
    });
  });
});

document.querySelectorAll('.formats input').forEach(cb => {
  cb.addEventListener('change', saveFormats);
});

// ── 초기화 ───────────────────────────────────────────────
async function init() {
  setStatus('확인 중', 'loading');
  try {
    const prefs = await chrome.storage.local.get(['lastFormats']);
    if (prefs.lastFormats?.length) {
      document.querySelectorAll('.formats input').forEach(cb => {
        cb.checked = prefs.lastFormats.includes(cb.value);
      });
    }

    // 이미 내보내기 진행 중이면 바로 진행 화면 표시
    const { exportStatus } = await chrome.storage.session.get('exportStatus');
    if (exportStatus?.status === 'running') {
      setStatus('연결됨', 'connected');
      show('progress');
      progressFill.className = 'progress-fill';
      batchStatus.classList.add('hidden');
      startPolling();
      return;
    }

    // 토큰 가져오기: 1순위 백그라운드 캐시
    const stored = await chrome.storage.session.get('discordToken');
    token = stored.discordToken ?? null;

    // 2순위: content script
    if (!token) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url?.includes('discord.com')) {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TOKEN' }).catch(() => null);
        token = resp?.token ?? null;
      }
    }

    const [discordTab] = await chrome.tabs.query({ url: 'https://discord.com/*' });
    if (!discordTab) {
      setStatus('Discord 탭 필요', 'disconnected');
      showPlaceholder('Discord 웹(discord.com)을 열고 로그인해주세요.');
      return;
    }

    if (!token) {
      setStatus('토큰 대기 중', 'loading');
      showPlaceholder('Discord에서 아무 채널이나 클릭한 뒤\n팝업을 다시 열어주세요.');
      return;
    }

    setStatus('연결됨', 'connected');
    await loadDMs();
  } catch (e) {
    setStatus('오류', 'disconnected');
    showPlaceholder('오류: ' + e.message);
  }
}

function setStatus(text, type) {
  statusChip.textContent = text;
  statusChip.className = `status-chip ${type}`;
}

// ── DM 목록 ──────────────────────────────────────────────
async function loadDMs() {
  showPlaceholder('DM 목록 불러오는 중...');
  try {
    const channels = await apiFetch('/users/@me/channels');
    allDMChannels = channels
      .filter(c => (c.type === 1 || c.type === 3) && c.recipients?.length > 0)
      .sort((a, b) => (b.last_message_id ?? '0').localeCompare(a.last_message_id ?? '0'));

    if (!allDMChannels.length) { showPlaceholder('DM 채널이 없습니다.'); return; }

    renderDMList(allDMChannels);

    const prefs = await chrome.storage.local.get(['lastChannelId']);
    if (prefs.lastChannelId) {
      const ch = allDMChannels.find(c => c.id === prefs.lastChannelId);
      if (ch) selectDM(ch, ch.recipients[0], false);
    }
  } catch (e) {
    showPlaceholder('DM 목록을 불러올 수 없습니다.\n' + e.message);
  }
}

function filterChannels(q) {
  if (!q.trim()) return allDMChannels;
  const lq = q.toLowerCase();
  return allDMChannels.filter(ch => {
    const name = getChannelName(ch).toLowerCase();
    return name.includes(lq) || ch.recipients.some(r =>
      r.username.toLowerCase().includes(lq) || (r.global_name ?? '').toLowerCase().includes(lq)
    );
  });
}

function renderDMList(channels) {
  if (!channels.length) { showPlaceholder('검색 결과가 없습니다.'); return; }
  dmListEl.innerHTML = '';
  if (isMultiSelect) dmListEl.classList.add('multiselect');
  else dmListEl.classList.remove('multiselect');

  channels.forEach(ch => {
    const u       = ch.recipients[0];
    const isGroup = ch.type === 3;
    const name    = getChannelName(ch);
    const isSelected = selectedMap.has(ch.id);

    const item = document.createElement('div');
    item.className = 'dm-item' + (isSelected ? ' selected' : '');
    item.dataset.channelId = ch.id;

    const check = document.createElement('div');
    check.className = 'dm-check';
    item.appendChild(check);

    const img = makeAvatar(ch, 36, 'dm-avatar');
    item.appendChild(img);

    const info = document.createElement('div');
    info.className = 'dm-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'dm-name';
    nameEl.textContent = name;
    info.appendChild(nameEl);

    if (isGroup) {
      const tag = document.createElement('span');
      tag.className = 'dm-tag';
      tag.textContent = `그룹 ${ch.recipients.length + 1}명`;
      info.appendChild(tag);
    } else if (u.global_name && u.global_name !== u.username) {
      const sub = document.createElement('span');
      sub.className = 'dm-sub';
      sub.textContent = u.global_name;
      info.appendChild(sub);
    }
    item.appendChild(info);

    item.addEventListener('click', () => {
      if (isMultiSelect) toggleMultiItem(ch, u, item);
      else selectDM(ch, u, true);
    });
    dmListEl.appendChild(item);
  });
}

function showPlaceholder(msg) {
  dmListEl.innerHTML = `<div class="dm-placeholder"><span>${msg}</span></div>`;
}

// ── 다중선택 토글 ─────────────────────────────────────────
function toggleMultiSelect() {
  isMultiSelect = !isMultiSelect;
  multiselectBtn.classList.toggle('active', isMultiSelect);
  multiselectBtn.textContent = isMultiSelect ? '선택완료' : '다중선택';
  clearSelection();
  renderDMList(filterChannels(dmSearch.value));
}

function toggleMultiItem(channel, user, itemEl) {
  if (selectedMap.has(channel.id)) {
    selectedMap.delete(channel.id);
    itemEl.classList.remove('selected');
  } else {
    selectedMap.set(channel.id, { channel, user });
    itemEl.classList.add('selected');
  }
  updateSelectionUI();
}

// ── 단일/다중 선택 UI ─────────────────────────────────────
function selectDM(channel, user, saveToStorage = true) {
  selectedMap.clear();
  selectedMap.set(channel.id, { channel, user });

  selAvatar.referrerPolicy = 'no-referrer';
  selAvatar.src = avatarUrl(channel, 30);
  selAvatar.onerror = () => { selAvatar.src = fallbackAvatar(user.id); };
  selName.textContent = getChannelName(channel);
  selSince.textContent = '대화 시작: ' + snowflakeToDateStr(channel.id);

  if (saveToStorage) chrome.storage.local.set({ lastChannelId: channel.id });
  updateSelectionUI();
  clearError();
}

function clearSelection() {
  selectedMap.clear();
  if (!isMultiSelect) {
    renderDMList(filterChannels(dmSearch.value));
  } else {
    document.querySelectorAll('.dm-item.selected').forEach(el => el.classList.remove('selected'));
  }
  updateSelectionUI();
}

function updateSelectionUI() {
  const count = selectedMap.size;
  if (count === 0) { show('dm'); return; }

  show('export');
  if (isMultiSelect) {
    selectedChip.style.display = 'none';
    selectedCount.classList.remove('hidden');
    selCountText.textContent = `${count}개 DM 선택됨`;
  } else {
    selectedChip.style.display = '';
    selectedCount.classList.add('hidden');
  }
}

// ── 화면 전환 ────────────────────────────────────────────
function show(screen) {
  sectionDm.classList.toggle('hidden', screen !== 'dm');
  sectionExport.classList.toggle('hidden', screen !== 'export');
  sectionProgress.classList.toggle('hidden', screen !== 'progress');
}

// ── 내보내기 실행 (백그라운드에 위임) ─────────────────────
function runExport() {
  const formats = [...document.querySelectorAll('.formats input:checked')].map(el => el.value);
  if (!formats.length)   { showError('형식을 하나 이상 선택하세요.'); return; }
  if (!selectedMap.size) { showError('DM을 선택하세요.'); return; }

  clearError();
  show('progress');
  progressFill.className = 'progress-fill';
  batchStatus.classList.add('hidden');
  elapsedTimeEl.textContent = '00:00';
  progressText.textContent = '준비 중...';

  const items = [...selectedMap.values()].map(({ channel, user }) => ({
    channelId: channel.id,
    channelName: getChannelName(channel),
    recipient: user,
  }));

  chrome.runtime.sendMessage({
    type: 'START_EXPORT',
    params: { items, formats, dateFrom: dateFrom.value, dateTo: dateTo.value },
  });
  startPolling();
}

function cancelExport() {
  chrome.runtime.sendMessage({ type: 'CANCEL_EXPORT' });
  stopPolling();
  show('dm');
  batchStatus.classList.add('hidden');
}

// ── 폴링: 백그라운드 진행 상태 반영 ──────────────────────
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const { exportStatus } = await chrome.storage.session.get('exportStatus');
    if (exportStatus) applyStatus(exportStatus);
  }, 500);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function applyStatus(s) {
  if (s.status === 'running') {
    progressText.textContent = s.message ?? '진행 중...';
    if ((s.batchTotal ?? 1) > 1) {
      batchStatus.textContent = `${s.batchCurrent} / ${s.batchTotal} — ${s.channelName ?? ''}`;
      batchStatus.classList.remove('hidden');
    } else {
      batchStatus.classList.add('hidden');
    }
    if (s.startTime) {
      const elapsed = Math.floor((Date.now() - s.startTime) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(elapsed % 60).padStart(2, '0');
      elapsedTimeEl.textContent = `${mm}:${ss}`;
    }
  } else if (s.status === 'done') {
    stopPolling();
    progressFill.className = 'progress-fill done';
    progressText.textContent = s.message ?? '완료';
    batchStatus.classList.add('hidden');
    setTimeout(() => { show('dm'); clearError(); }, 4000);
  } else if (s.status === 'error') {
    stopPolling();
    show('export');
    showError(s.message ?? '오류가 발생했습니다.');
    batchStatus.classList.add('hidden');
  } else if (s.status === 'cancelled') {
    stopPolling();
    show('dm');
    batchStatus.classList.add('hidden');
  }
}

// ── 오류 표시 ────────────────────────────────────────────
function showError(msg) { errorBox.textContent = msg; errorBox.classList.remove('hidden'); }
function clearError()   { errorBox.classList.add('hidden'); }

// ── 형식 저장 ─────────────────────────────────────────────
function saveFormats() {
  const formats = [...document.querySelectorAll('.formats input:checked')].map(el => el.value);
  chrome.storage.local.set({ lastFormats: formats });
}

// ── Discord API (DM 목록 로딩용) ─────────────────────────
async function apiFetch(path, params = {}) {
  const url = new URL(API + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  for (let i = 0; i < 5; i++) {
    const resp = await fetch(url.toString(), {
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    });
    if (resp.status === 429) {
      const body = await resp.json().catch(() => ({}));
      await sleep((body.retry_after ?? 1) * 1000 + 200);
      continue;
    }
    if (!resp.ok) throw new Error(`Discord API 오류: ${resp.status}`);
    return resp.json();
  }
  throw new Error('Rate limit 재시도 초과. 잠시 후 다시 시도하세요.');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 유틸 ─────────────────────────────────────────────────
function getChannelName(ch) {
  if (ch.type === 3) return ch.name || ch.recipients.map(r => r.username).join(', ');
  return ch.recipients[0]?.username ?? 'Unknown';
}

function avatarUrl(ch, size = 40) {
  if (ch.type === 3 && ch.icon) {
    return `https://cdn.discordapp.com/channel-icons/${ch.id}/${ch.icon}.png?size=${size}`;
  }
  const u = ch.recipients?.[0];
  if (!u) return fallbackAvatar('0');
  return u.avatar
    ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=${size}`
    : fallbackAvatar(u.id);
}

function fallbackAvatar(userId) {
  return `https://cdn.discordapp.com/embed/avatars/${Number(userId) % 5}.png`;
}

function makeAvatar(ch, size, className) {
  const img = document.createElement('img');
  img.className = className;
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.src = avatarUrl(ch, size);
  const u = ch.recipients?.[0];
  img.addEventListener('error', () => { img.src = fallbackAvatar(u?.id ?? '0'); });
  return img;
}

function snowflakeToDateStr(id) {
  try {
    const ms = Number(BigInt(id) >> 22n) + Number(DISCORD_EPOCH);
    return new Date(ms).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long' });
  } catch { return ''; }
}
