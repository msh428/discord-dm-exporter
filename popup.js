'use strict';

const API = 'https://discord.com/api/v9';

// ── 상태 ─────────────────────────────────────────────────
let token           = null;
let allDMChannels   = [];
let selectedChannel = null;
let selectedUser    = null;
let abortController = null;

// ── DOM ──────────────────────────────────────────────────
const statusChip      = document.getElementById('status-chip');
const dmSearch        = document.getElementById('dm-search');
const dmListEl        = document.getElementById('dm-list');
const sectionDm       = document.getElementById('section-dm');
const sectionExport   = document.getElementById('section-export');
const sectionProgress = document.getElementById('section-progress');
const selAvatar       = document.getElementById('sel-avatar');
const selName         = document.getElementById('sel-name');
const btnDeselect     = document.getElementById('btn-deselect');
const dateFrom        = document.getElementById('date-from');
const dateTo          = document.getElementById('date-to');
const exportBtn       = document.getElementById('export-btn');
const progressFill    = document.getElementById('progress-fill');
const progressText    = document.getElementById('progress-text');
const cancelBtn       = document.getElementById('cancel-btn');
const errorBox        = document.getElementById('error-box');
const cryptoBtn       = document.getElementById('crypto-btn');
const cryptoModal     = document.getElementById('crypto-modal');
const modalClose      = document.getElementById('modal-close');

// ── 이벤트 ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
dmSearch.addEventListener('input', () => renderDMList(filterChannels(dmSearch.value)));
btnDeselect.addEventListener('click', deselectDM);
exportBtn.addEventListener('click', runExport);
cancelBtn.addEventListener('click', cancelExport);
cryptoBtn.addEventListener('click', () => cryptoModal.classList.remove('hidden'));
modalClose.addEventListener('click', () => cryptoModal.classList.add('hidden'));
cryptoModal.addEventListener('click', e => { if (e.target === cryptoModal) cryptoModal.classList.add('hidden'); });

document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const text = document.getElementById(btn.dataset.target)?.textContent.trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '복사'; btn.classList.remove('copied'); }, 2000);
    });
  });
});

// ── 초기화 ───────────────────────────────────────────────
async function init() {
  setStatus('확인 중', 'loading');
  try {
    // 1순위: 백그라운드가 가로챈 실제 토큰 (가장 신뢰할 수 있음)
    const stored = await chrome.storage.session.get('discordToken');
    token = stored.discordToken ?? null;

    // 2순위: content script → injected.js(MAIN world) 경유
    if (!token) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url?.includes('discord.com')) {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TOKEN' }).catch(() => null);
        token = resp?.token ?? null;
      }
    }

    // Discord 탭 여부 확인
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

// ── DM 목록 로드 ─────────────────────────────────────────
async function loadDMs() {
  showPlaceholder('DM 목록 불러오는 중...');
  try {
    const channels = await apiFetch('/users/@me/channels');
    allDMChannels = channels
      .filter(c => c.type === 1 && c.recipients?.length > 0)
      .sort((a, b) => (b.last_message_id ?? '0').localeCompare(a.last_message_id ?? '0'));

    if (!allDMChannels.length) {
      showPlaceholder('DM 채널이 없습니다.');
      return;
    }
    renderDMList(allDMChannels);
  } catch (e) {
    showPlaceholder('DM 목록을 불러올 수 없습니다.\n' + e.message);
  }
}

function filterChannels(q) {
  if (!q.trim()) return allDMChannels;
  const lq = q.toLowerCase();
  return allDMChannels.filter(ch => {
    const u = ch.recipients[0];
    return u.username.toLowerCase().includes(lq)
      || (u.global_name ?? '').toLowerCase().includes(lq);
  });
}

function renderDMList(channels) {
  if (!channels.length) {
    showPlaceholder('검색 결과가 없습니다.');
    return;
  }
  dmListEl.innerHTML = '';
  channels.forEach(ch => {
    const u = ch.recipients[0];
    const item = document.createElement('div');
    item.className = 'dm-item' + (selectedChannel?.id === ch.id ? ' selected' : '');
    item.dataset.channelId = ch.id;
    item.innerHTML = `
      <img class="dm-avatar" src="${avatarUrl(u, 36)}"
           onerror="this.src='${fallbackAvatar(u.id)}'" alt="">
      <div class="dm-info">
        <span class="dm-name">${esc(u.username)}</span>
        ${u.global_name && u.global_name !== u.username
          ? `<span class="dm-sub">${esc(u.global_name)}</span>` : ''}
      </div>`;
    item.addEventListener('click', () => selectDM(ch, u));
    dmListEl.appendChild(item);
  });
}

function showPlaceholder(msg) {
  dmListEl.innerHTML = `<div class="dm-placeholder"><span>${msg}</span></div>`;
}

// ── DM 선택 / 해제 ───────────────────────────────────────
function selectDM(channel, user) {
  selectedChannel = channel;
  selectedUser    = user;

  selAvatar.src = avatarUrl(user, 30);
  selAvatar.onerror = () => { selAvatar.src = fallbackAvatar(user.id); };
  selName.textContent = user.username;

  show('export');
  clearError();
}

function deselectDM() {
  selectedChannel = null;
  selectedUser    = null;
  show('dm');
  clearError();
  // 선택 해제 시 목록 다시 렌더링 (선택 강조 제거)
  renderDMList(filterChannels(dmSearch.value));
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
  if (!formats.length) { showError('형식을 하나 이상 선택하세요.'); return; }

  abortController = new AbortController();
  clearError();
  show('progress');
  progressFill.className = 'progress-fill';
  setProgress('메시지 수집 중...');

  try {
    const messages = await fetchAllMessages(
      selectedChannel.id,
      dateFrom.value,
      dateTo.value,
      abortController.signal,
    );

    if (abortController.signal.aborted) return;

    setProgress(`${messages.length.toLocaleString()}개 완료. 파일 생성 중...`);

    const me = await apiFetch('/users/@me', {}, abortController.signal);
    const safe = selectedUser.username.replace(/[/\\:*?"<>|]/g, '_');

    if (formats.includes('json')) downloadJSON(messages, `dm_${safe}.json`);
    if (formats.includes('csv'))  downloadCSV(messages,  `dm_${safe}.csv`);
    if (formats.includes('txt'))  downloadTXT(messages,  `dm_${safe}.txt`);
    if (formats.includes('html')) downloadHTML(messages, selectedUser, me, `dm_${safe}.html`);

    progressFill.className = 'progress-fill done';
    setProgress(`✓ ${messages.length.toLocaleString()}개 메시지를 내보냈습니다.`);

    setTimeout(() => show('export'), 3000);

  } catch (e) {
    if (e.name === 'AbortError') {
      show('export');
    } else {
      show('export');
      showError(e.message);
    }
  }
}

function cancelExport() {
  abortController?.abort();
  show('export');
}

function setProgress(msg) { progressText.textContent = msg; }
function showError(msg)    { errorBox.textContent = msg; errorBox.classList.remove('hidden'); }
function clearError()      { errorBox.classList.add('hidden'); }

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
  throw new Error('Rate limit 재시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
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
function avatarUrl(user, size = 40) {
  return user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=${size}`
    : fallbackAvatar(user.id);
}

function fallbackAvatar(userId) {
  return `https://cdn.discordapp.com/embed/avatars/${Number(userId) % 5}.png`;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTs(ts) {
  return new Date(ts).toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
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
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }

  const rows = messages.map(m => {
    const isMe = m.author.id === me.id;
    const ts   = fmtTs(m.timestamp);
    const date = ts.slice(0, 10);
    const av   = avatarUrl(m.author, 40);

    const attachHtml = (m.attachments ?? []).map(a =>
      (a.content_type ?? '').startsWith('image/')
        ? `<img src="${a.url}" class="att-img" loading="lazy" alt="">`
        : `<a href="${a.url}" class="att-link" target="_blank">${escH(a.filename)}</a>`
    ).join('');

    const embedHtml = (m.embeds ?? []).map(e => {
      const color = `#${(e.color ?? 0x5865F2).toString(16).padStart(6, '0')}`;
      return `<div class="embed" style="border-left-color:${color}">
        ${e.title       ? `<div class="embed-title">${escH(e.title)}</div>` : ''}
        ${e.description ? `<div class="embed-desc">${escH(e.description)}</div>` : ''}
        ${e.image?.url  ? `<img src="${e.image.url}" class="att-img" loading="lazy" alt="">` : ''}
      </div>`;
    }).join('');

    const reactionHtml = (m.reactions ?? []).map(r =>
      `<span class="reaction">${r.emoji.name ?? '?'} ${r.count}</span>`
    ).join('');

    const replyHtml = m.referenced_message
      ? `<div class="reply">
          <span class="reply-author">${escH(m.referenced_message.author?.username ?? '')}</span>
          <span class="reply-content">${escH((m.referenced_message.content ?? '').slice(0, 80))}</span>
         </div>`
      : '';

    return `<div class="${isMe ? 'msg msg-me' : 'msg'}" data-date="${date}" data-ts="${ts}">
      <img src="${av}" class="avatar"
           onerror="this.src='https://cdn.discordapp.com/embed/avatars/${Number(m.author.id) % 5}.png'" alt="">
      <div class="body">
        ${replyHtml}
        <div class="hdr">
          <span class="name">${escH(m.author.username)}</span>
          <span class="ts" title="${ts}">${ts.slice(11, 16)}</span>
        </div>
        <div class="content">${escH(m.content)}</div>
        ${attachHtml}${embedHtml}
        ${reactionHtml ? `<div class="reactions">${reactionHtml}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  const rname = escH(recipient?.username ?? 'Unknown');
  const total = messages.length;

  const html = `<!DOCTYPE html>
<html lang="ko" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DM — ${rname}</title>
<style>
:root {
  --bg: #313338; --bg2: #2b2d31; --bg3: #1e1f22;
  --text: #dcddde; --text2: #b5bac1; --muted: #80848e;
  --accent: #5865f2; --success: #3ba55c;
  --border: #3c3f44; --hover: #2e3035;
  --msg-bg: transparent;
}
[data-theme="light"] {
  --bg: #ffffff; --bg2: #f2f3f5; --bg3: #e3e5e8;
  --text: #2e3338; --text2: #4e5058; --muted: #80848e;
  --border: #d4d7dc; --hover: #f2f3f5;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',-apple-system,sans-serif;font-size:15px;min-height:100vh}

/* 툴바 */
.toolbar{background:var(--bg3);border-bottom:1px solid var(--border);padding:12px 20px;
         position:sticky;top:0;z-index:100;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.toolbar-info{flex:1;min-width:0}
.toolbar-info h1{font-size:16px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toolbar-info small{font-size:12px;color:var(--muted)}
.toolbar-controls{display:flex;align-items:center;gap:8px}
.search-input{background:var(--bg2);border:1.5px solid var(--border);border-radius:6px;
              padding:6px 12px;color:var(--text);font-size:13px;outline:none;width:200px;transition:border-color .15s}
.search-input:focus{border-color:var(--accent)}
.search-input::placeholder{color:var(--muted)}
.search-count{font-size:12px;color:var(--muted);white-space:nowrap}
.theme-btn{background:var(--bg2);border:1.5px solid var(--border);border-radius:6px;
           padding:6px 10px;color:var(--text2);cursor:pointer;font-size:14px;
           transition:background .15s,border-color .15s}
.theme-btn:hover{background:var(--bg3);border-color:var(--accent)}

/* 채팅 영역 */
.chat{max-width:860px;margin:0 auto;padding:16px 20px;display:flex;flex-direction:column;gap:0}

/* 날짜 구분선 */
.divider{display:flex;align-items:center;gap:10px;margin:16px 0;position:sticky;top:56px;z-index:10;
         padding:0 2px}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}
.divider span{font-size:12px;font-weight:700;color:var(--muted);white-space:nowrap;
              background:var(--bg);padding:2px 8px;border-radius:10px;border:1px solid var(--border)}

/* 메시지 */
.msg{display:flex;gap:14px;padding:3px 6px;border-radius:6px;transition:background .1s}
.msg:hover{background:var(--hover)}
.msg.hidden{display:none}
.msg.highlight .body{background:var(--accent)18;border-radius:4px;padding:2px 6px;margin:-2px -6px}
.avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0;margin-top:2px;background:var(--bg3);object-fit:cover}
.body{flex:1;min-width:0}
.hdr{display:flex;align-items:baseline;gap:8px;margin-bottom:2px}
.name{font-weight:700;color:var(--text);font-size:15px}
.ts{font-size:11px;color:var(--muted);cursor:default}
.content{color:var(--text);line-height:1.5;word-break:break-word;white-space:pre-wrap}

/* 답장 미리보기 */
.reply{display:flex;align-items:center;gap:6px;margin-bottom:4px;padding:4px 8px;
       background:var(--bg2);border-left:2px solid var(--muted);border-radius:4px;
       font-size:13px;color:var(--muted)}
.reply-author{font-weight:700;color:var(--accent);flex-shrink:0}
.reply-content{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 첨부파일 */
.att-img{max-width:420px;max-height:320px;border-radius:6px;margin-top:6px;display:block;object-fit:contain}
.att-link{display:inline-flex;align-items:center;gap:6px;margin-top:6px;color:var(--accent);
          font-size:13px;text-decoration:none;padding:6px 10px;background:var(--bg2);
          border-radius:6px;border:1px solid var(--border)}
.att-link:hover{text-decoration:underline}

/* 임베드 */
.embed{border-left:4px solid var(--accent);background:var(--bg2);border-radius:4px;
       padding:10px 14px;margin-top:6px;max-width:520px;display:flex;flex-direction:column;gap:4px}
.embed-title{font-weight:700;color:var(--text)}
.embed-desc{color:var(--text2);font-size:14px;line-height:1.4}

/* 리액션 */
.reactions{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.reaction{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;
          background:var(--bg2);border:1px solid var(--border);border-radius:20px;
          font-size:13px;color:var(--text2);cursor:default}

/* 스크롤 버튼 */
.scroll-btns{position:fixed;right:20px;bottom:20px;display:flex;flex-direction:column;gap:6px;z-index:200}
.scroll-btn{background:var(--bg3);border:1px solid var(--border);border-radius:8px;
            padding:8px 12px;cursor:pointer;color:var(--text2);font-size:14px;
            box-shadow:0 2px 8px #00000040;transition:background .1s}
.scroll-btn:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
</style>
</head>
<body>

<div class="toolbar">
  <div class="toolbar-info">
    <h1>@ ${rname} 와의 DM</h1>
    <small id="msg-info">총 ${total.toLocaleString()}개 메시지</small>
  </div>
  <div class="toolbar-controls">
    <input class="search-input" id="q" type="text" placeholder="검색..." oninput="doSearch(this.value)">
    <span class="search-count" id="search-count"></span>
    <button class="theme-btn" id="theme-btn" onclick="toggleTheme()" title="다크/라이트 모드">🌙</button>
  </div>
</div>

<div class="chat" id="chat">${rows}</div>

<div class="scroll-btns">
  <button class="scroll-btn" onclick="window.scrollTo({top:0,behavior:'smooth'})" title="맨 위로">↑</button>
  <button class="scroll-btn" onclick="window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'})" title="맨 아래로">↓</button>
</div>

<script>
(function(){
  // 날짜 구분선 삽입
  const msgs = [...document.querySelectorAll('.msg')];
  let lastDate = '';
  msgs.forEach(m => {
    const d = m.dataset.date;
    if (d && d !== lastDate) {
      const el = document.createElement('div');
      el.className = 'divider';
      el.innerHTML = '<span>' + d + '</span>';
      m.before(el);
      lastDate = d;
    }
  });

  // 검색
  window.doSearch = function(q) {
    const lq = q.toLowerCase().trim();
    let count = 0;
    msgs.forEach(m => {
      if (!lq) { m.classList.remove('hidden', 'highlight'); return; }
      const text = (m.querySelector('.content')?.textContent ?? '').toLowerCase();
      const author = (m.querySelector('.name')?.textContent ?? '').toLowerCase();
      const match = text.includes(lq) || author.includes(lq);
      m.classList.toggle('hidden', !match);
      m.classList.toggle('highlight', match);
      if (match) count++;
    });
    const el = document.getElementById('search-count');
    el.textContent = lq ? count + '개' : '';
  };

  // 다크/라이트 모드
  window.toggleTheme = function() {
    const html = document.documentElement;
    const isDark = html.dataset.theme !== 'light';
    html.dataset.theme = isDark ? 'light' : 'dark';
    document.getElementById('theme-btn').textContent = isDark ? '☀️' : '🌙';
  };

  // 맨 아래로 스크롤
  window.scrollTo(0, document.body.scrollHeight);
})();
<\/script>
</body>
</html>`;

  downloadBlob(html, filename, 'text/html;charset=utf-8');
}
