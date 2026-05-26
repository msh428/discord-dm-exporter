'use strict';

const API            = 'https://discord.com/api/v9';
const DISCORD_EPOCH  = 1420070400000n;

// ── 상태 ─────────────────────────────────────────────────
let token           = null;
let allDMChannels   = [];
let isMultiSelect   = false;
let selectedMap     = new Map(); // channelId → { channel, user }
let abortController = null;
let elapsedTimer    = null;
let exportStartTime = null;

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

// ── 형식 변경 시 저장 ─────────────────────────────────────
document.querySelectorAll('.formats input').forEach(cb => {
  cb.addEventListener('change', saveFormats);
});

// ── 초기화 ───────────────────────────────────────────────
async function init() {
  setStatus('확인 중', 'loading');
  try {
    // 저장된 형식 복원
    const prefs = await chrome.storage.local.get(['lastFormats']);
    if (prefs.lastFormats?.length) {
      document.querySelectorAll('.formats input').forEach(cb => {
        cb.checked = prefs.lastFormats.includes(cb.value);
      });
    }

    // 1순위: 백그라운드가 가로챈 토큰
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

    // 마지막으로 선택한 채널 복원
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

    // 다중선택 체크박스 자리
    const check = document.createElement('div');
    check.className = 'dm-check';
    item.appendChild(check);

    // 아바타
    const img = makeAvatar(ch, 36, 'dm-avatar');
    item.appendChild(img);

    // 정보
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

  if (saveToStorage) {
    chrome.storage.local.set({ lastChannelId: channel.id });
  }
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

  if (count === 0) {
    show('dm');
    return;
  }

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

// ── 내보내기 실행 ─────────────────────────────────────────
async function runExport() {
  const formats = [...document.querySelectorAll('.formats input:checked')].map(el => el.value);
  if (!formats.length)      { showError('형식을 하나 이상 선택하세요.'); return; }
  if (!selectedMap.size)    { showError('DM을 선택하세요.'); return; }

  abortController = new AbortController();
  clearError();
  show('progress');
  progressFill.className = 'progress-fill';
  startElapsedTimer();

  const items    = [...selectedMap.values()];
  const isMulti  = items.length > 1;
  let totalMsgs  = 0;

  try {
    const me = await apiFetch('/users/@me', {}, abortController.signal);

    for (let i = 0; i < items.length; i++) {
      if (abortController.signal.aborted) break;

      const { channel, user } = items[i];
      const name = getChannelName(channel);

      if (isMulti) {
        batchStatus.textContent = `${i + 1} / ${items.length} — ${name}`;
        batchStatus.classList.remove('hidden');
      }

      setProgress('메시지 수집 중...');
      const messages = await fetchAllMessages(
        channel.id, dateFrom.value, dateTo.value, abortController.signal
      );
      if (abortController.signal.aborted) break;

      setProgress(`${messages.length.toLocaleString()}개 완료. 파일 생성 중...`);
      const safe = name.replace(/[/\\:*?"<>|]/g, '_');

      if (formats.includes('json')) downloadJSON(messages, `dm_${safe}.json`);
      if (formats.includes('csv'))  downloadCSV(messages,  `dm_${safe}.csv`);
      if (formats.includes('txt'))  downloadTXT(messages,  `dm_${safe}.txt`);
      if (formats.includes('html')) downloadHTML(messages, user, me, `dm_${safe}.html`);

      totalMsgs += messages.length;
    }

    if (!abortController.signal.aborted) {
      progressFill.className = 'progress-fill done';
      const label = isMulti
        ? `✓ ${items.length}개 DM, 총 ${totalMsgs.toLocaleString()}개 메시지 완료`
        : `✓ ${totalMsgs.toLocaleString()}개 메시지를 내보냈습니다.`;
      setProgress(label);
      batchStatus.classList.add('hidden');
      stopElapsedTimer();

      // 완료 알림
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon48.png'),
        title: 'Discord DM Exporter',
        message: label.replace('✓ ', ''),
      });

      setTimeout(() => { show('export'); batchStatus.classList.add('hidden'); }, 4000);
    }
  } catch (e) {
    stopElapsedTimer();
    if (e.name !== 'AbortError') showError(e.message);
    show('export');
    batchStatus.classList.add('hidden');
  }
}

function cancelExport() {
  abortController?.abort();
  stopElapsedTimer();
  show('export');
  batchStatus.classList.add('hidden');
}

// ── 경과 시간 타이머 ──────────────────────────────────────
function startElapsedTimer() {
  exportStartTime = Date.now();
  elapsedTimeEl.textContent = '00:00';
  elapsedTimer = setInterval(() => {
    const s = Math.floor((Date.now() - exportStartTime) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    elapsedTimeEl.textContent = `${mm}:${ss}`;
  }, 1000);
}

function stopElapsedTimer() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

function setProgress(msg) { progressText.textContent = msg; }
function showError(msg)   { errorBox.textContent = msg; errorBox.classList.remove('hidden'); }
function clearError()     { errorBox.classList.add('hidden'); }

// ── 형식 저장 ─────────────────────────────────────────────
function saveFormats() {
  const formats = [...document.querySelectorAll('.formats input:checked')].map(el => el.value);
  chrome.storage.local.set({ lastFormats: formats });
}

// ── Discord API ───────────────────────────────────────────
async function apiFetch(path, params = {}, signal = null) {
  const url = new URL(API + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  for (let i = 0; i < 5; i++) {
    const resp = await fetch(url.toString(), {
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      signal,
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

async function fetchAllMessages(channelId, fromDate, toDate, signal) {
  const messages = [];
  let before = null;
  const fromTs = fromDate ? new Date(fromDate + 'T00:00:00+09:00').getTime() : null;
  const toTs   = toDate   ? new Date(toDate   + 'T23:59:59+09:00').getTime() : null;

  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const params = { limit: 100 };
    if (before) params.before = before;
    const batch = await apiFetch(`/channels/${channelId}/messages`, params, signal);
    if (!batch.length) break;
    let stop = false;
    for (const m of batch) {
      const ts = new Date(m.timestamp).getTime();
      if (toTs   && ts > toTs)   continue;
      if (fromTs && ts < fromTs) { stop = true; break; }
      messages.push(m);
    }
    before = batch[batch.length - 1].id;
    setProgress(`메시지 수집 중... ${messages.length.toLocaleString()}개`);
    await sleep(380);
    if (stop || batch.length < 100) break;
  }
  messages.sort((a, b) => a.id.localeCompare(b.id));
  return messages;
}

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

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTs(ts) {
  return new Date(ts).toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: false }, () => URL.revokeObjectURL(url));
}

// ── 내보내기 형식 ─────────────────────────────────────────
function downloadJSON(messages, filename) {
  downloadBlob(JSON.stringify(messages, null, 2), filename, 'application/json');
}

function downloadCSV(messages, filename) {
  const header = 'timestamp,author,content,attachments\n';
  const rows = messages.map(m =>
    [fmtTs(m.timestamp), m.author.username, m.content ?? '',
     (m.attachments ?? []).map(a => a.url).join(' | ')]
      .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
  );
  downloadBlob('﻿' + header + rows.join('\n'), filename, 'text/csv;charset=utf-8');
}

function downloadTXT(messages, filename) {
  const lines = messages.map(m => {
    let line = `[${fmtTs(m.timestamp)}] ${m.author.username}: ${m.content ?? ''}`;
    (m.attachments ?? []).forEach(a => { line += `\n  [첨부] ${a.url}`; });
    return line;
  });
  downloadBlob(lines.join('\n'), filename, 'text/plain;charset=utf-8');
}

// ── HTML 내보내기 ─────────────────────────────────────────
function downloadHTML(messages, recipient, me, filename) {
  function escH(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  }
  function avUrl(author) {
    return author.avatar
      ? `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=40`
      : `https://cdn.discordapp.com/embed/avatars/${Number(author.id) % 5}.png`;
  }

  const rows = messages.map(m => {
    const ts   = fmtTs(m.timestamp);
    const date = ts.slice(0, 10);
    const isMe = m.author.id === me.id;

    const attachHtml = (m.attachments ?? []).map(a =>
      (a.content_type ?? '').startsWith('image/')
        ? `<img src="${a.url}" class="att-img" loading="lazy" referrerpolicy="no-referrer" alt="">`
        : `<a href="${a.url}" class="att-link" target="_blank">${escH(a.filename)}</a>`
    ).join('');

    const embedHtml = (m.embeds ?? []).map(e => {
      const color = `#${(e.color ?? 0x5865F2).toString(16).padStart(6, '0')}`;
      return `<div class="embed" style="border-left-color:${color}">
        ${e.title       ? `<div class="embed-title">${escH(e.title)}</div>` : ''}
        ${e.description ? `<div class="embed-desc">${escH(e.description)}</div>` : ''}
        ${e.image?.url  ? `<img src="${e.image.url}" class="att-img" loading="lazy" referrerpolicy="no-referrer" alt="">` : ''}
      </div>`;
    }).join('');

    const reactHtml = (m.reactions ?? []).map(r =>
      `<span class="reaction">${r.emoji.name ?? '?'} <b>${r.count}</b></span>`
    ).join('');

    const replyHtml = m.referenced_message ? `
      <div class="reply">
        <span class="reply-author">${escH(m.referenced_message.author?.username ?? '')}</span>
        <span class="reply-text">${escH((m.referenced_message.content ?? '').slice(0, 100))}</span>
      </div>` : '';

    return `<div class="${isMe ? 'msg msg-me' : 'msg'}" data-date="${date}">
      <img src="${avUrl(m.author)}" class="avatar" loading="lazy" referrerpolicy="no-referrer"
           onerror="this.src='https://cdn.discordapp.com/embed/avatars/${Number(m.author.id) % 5}.png'" alt="">
      <div class="body">
        ${replyHtml}
        <div class="hdr">
          <span class="name">${escH(m.author.username)}</span>
          <span class="ts">${ts}</span>
        </div>
        <div class="content">${escH(m.content)}</div>
        ${attachHtml}${embedHtml}
        ${reactHtml ? `<div class="reactions">${reactHtml}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  const rname = escH(getChannelName({ type: 1, recipients: [recipient] }));
  const total = messages.length;

  const html = `<!DOCTYPE html>
<html lang="ko" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DM — ${rname}</title>
<style>
:root{--bg:#313338;--bg2:#2b2d31;--bg3:#1e1f22;--text:#dcddde;--text2:#b5bac1;--muted:#80848e;--accent:#5865f2;--border:#3c3f44;--hover:#2e3035}
[data-theme="light"]{--bg:#fff;--bg2:#f2f3f5;--bg3:#e3e5e8;--text:#2e3338;--text2:#4e5058;--muted:#80848e;--border:#d4d7dc;--hover:#f2f3f5}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',-apple-system,sans-serif;font-size:15px}
.toolbar{background:var(--bg3);border-bottom:1px solid var(--border);padding:12px 20px;position:sticky;top:0;z-index:100;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.toolbar-info{flex:1;min-width:0}
.toolbar-info h1{font-size:16px;font-weight:700;color:var(--text)}
.toolbar-info small{font-size:12px;color:var(--muted)}
.toolbar-controls{display:flex;align-items:center;gap:8px}
.search-input{background:var(--bg2);border:1.5px solid var(--border);border-radius:6px;padding:6px 12px;color:var(--text);font-size:13px;outline:none;width:180px;transition:border-color .15s}
.search-input:focus{border-color:var(--accent)}
.search-input::placeholder{color:var(--muted)}
.search-count{font-size:12px;color:var(--muted);min-width:30px}
.theme-btn{background:var(--bg2);border:1.5px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text2);cursor:pointer;font-size:14px;transition:background .15s}
.theme-btn:hover{background:var(--bg3)}
.chat{max-width:860px;margin:0 auto;padding:16px 20px}
.divider{display:flex;align-items:center;gap:10px;margin:16px 0;position:sticky;top:56px;z-index:10;padding:0 2px}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}
.divider span{font-size:12px;font-weight:700;color:var(--muted);white-space:nowrap;background:var(--bg);padding:2px 8px;border-radius:10px;border:1px solid var(--border)}
.msg{display:flex;gap:14px;padding:3px 6px;border-radius:6px;transition:background .1s}
.msg:hover{background:var(--hover)}
.msg.hidden{display:none!important}
.msg.highlight .body{background:var(--accent)18;border-radius:4px;padding:2px 6px;margin:-2px -6px}
.avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0;margin-top:2px;background:var(--bg3);object-fit:cover}
.body{flex:1;min-width:0}
.hdr{display:flex;align-items:baseline;gap:8px;margin-bottom:2px}
.name{font-weight:700;color:var(--text)}
.ts{font-size:11px;color:var(--muted)}
.content{color:var(--text);line-height:1.5;word-break:break-word;white-space:pre-wrap}
.reply{display:flex;align-items:center;gap:6px;margin-bottom:4px;padding:4px 8px;background:var(--bg2);border-left:2px solid var(--muted);border-radius:4px;font-size:13px;color:var(--muted);overflow:hidden}
.reply-author{font-weight:700;color:var(--accent);flex-shrink:0}
.reply-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.att-img{max-width:420px;max-height:320px;border-radius:6px;margin-top:6px;display:block;object-fit:contain}
.att-link{display:inline-flex;align-items:center;gap:6px;margin-top:6px;color:var(--accent);font-size:13px;text-decoration:none;padding:6px 10px;background:var(--bg2);border-radius:6px;border:1px solid var(--border)}
.att-link:hover{text-decoration:underline}
.embed{border-left:4px solid var(--accent);background:var(--bg2);border-radius:4px;padding:10px 14px;margin-top:6px;max-width:520px;display:flex;flex-direction:column;gap:4px}
.embed-title{font-weight:700;color:var(--text)}
.embed-desc{color:var(--text2);font-size:14px;line-height:1.4}
.reactions{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.reaction{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:var(--bg2);border:1px solid var(--border);border-radius:20px;font-size:13px;color:var(--text2)}
.scroll-btns{position:fixed;right:20px;bottom:20px;display:flex;flex-direction:column;gap:6px;z-index:200}
.scroll-btn{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:8px 12px;cursor:pointer;color:var(--text2);font-size:14px;box-shadow:0 2px 8px #00000040;transition:background .1s}
.scroll-btn:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
</style>
</head>
<body>
<div class="toolbar">
  <div class="toolbar-info">
    <h1>@ ${rname}</h1>
    <small>총 ${total.toLocaleString()}개 메시지</small>
  </div>
  <div class="toolbar-controls">
    <input class="search-input" id="q" type="text" placeholder="검색..." oninput="doSearch(this.value)">
    <span class="search-count" id="sc"></span>
    <button class="theme-btn" onclick="toggleTheme()">🌙</button>
  </div>
</div>
<div class="chat" id="chat">${rows}</div>
<div class="scroll-btns">
  <button class="scroll-btn" onclick="window.scrollTo({top:0,behavior:'smooth'})">↑</button>
  <button class="scroll-btn" onclick="window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'})">↓</button>
</div>
<script>
(function(){
  const msgs=[...document.querySelectorAll('.msg')];
  let last='';
  msgs.forEach(m=>{
    const d=m.dataset.date;
    if(d&&d!==last){const el=document.createElement('div');el.className='divider';el.innerHTML='<span>'+d+'</span>';m.before(el);last=d;}
  });
  window.doSearch=function(q){
    const lq=q.toLowerCase().trim();let n=0;
    msgs.forEach(m=>{
      if(!lq){m.classList.remove('hidden','highlight');return;}
      const ok=(m.querySelector('.content')?.textContent??'').toLowerCase().includes(lq)||(m.querySelector('.name')?.textContent??'').toLowerCase().includes(lq);
      m.classList.toggle('hidden',!ok);m.classList.toggle('highlight',ok);if(ok)n++;
    });
    document.getElementById('sc').textContent=lq?n+'개':'';
  };
  window.toggleTheme=function(){
    const h=document.documentElement,dark=h.dataset.theme!=='light';
    h.dataset.theme=dark?'light':'dark';
    document.querySelector('.theme-btn').textContent=dark?'☀️':'🌙';
  };
  window.scrollTo(0,document.body.scrollHeight);
})();
<\/script>
</body>
</html>`;

  downloadBlob(html, filename, 'text/html;charset=utf-8');
}
