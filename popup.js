'use strict';

const API = 'https://discord.com/api/v9';

// ─── DOM 요소 ───────────────────────────────────────────
const statusEl   = document.getElementById('status');
const userInput  = document.getElementById('user-input');
const exportBtn  = document.getElementById('export-btn');
const progressEl = document.getElementById('progress');
const fillEl     = document.getElementById('progress-fill');
const textEl     = document.getElementById('progress-text');
const errorEl    = document.getElementById('error');

// ─── 초기화 ──────────────────────────────────────────────
let token = null;

window.addEventListener('DOMContentLoaded', async () => {
  await checkDiscordTab();
  userInput.addEventListener('input', updateExportBtn);
});

exportBtn.addEventListener('click', runExport);

// ─── Discord 탭 확인 & 토큰 획득 ─────────────────────────
async function checkDiscordTab() {
  setStatus('확인 중...', 'loading');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes('discord.com')) {
      setStatus('Discord 탭을 열어주세요', 'disconnected');
      return;
    }
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TOKEN' }).catch(() => null);
    if (!resp?.token) {
      setStatus('Discord에 로그인되어 있지 않습니다', 'disconnected');
      return;
    }
    token = resp.token;
    setStatus('연결됨', 'connected');
    updateExportBtn();
  } catch {
    setStatus('오류가 발생했습니다', 'disconnected');
  }
}

function setStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = `status status-${type}`;
}

function updateExportBtn() {
  exportBtn.disabled = !(token && userInput.value.trim());
}

// ─── API 유틸 ─────────────────────────────────────────────
async function apiFetch(path, params = {}) {
  const url = new URL(API + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  let retries = 0;
  while (retries < 5) {
    const resp = await fetch(url.toString(), {
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
    });

    if (resp.status === 429) {
      const body = await resp.json();
      const wait = (body.retry_after ?? 1) * 1000 + 100;
      await sleep(wait);
      retries++;
      continue;
    }
    if (!resp.ok) throw new Error(`API 오류: ${resp.status}`);
    return resp.json();
  }
  throw new Error('Rate limit 재시도 초과');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Discord 데이터 조회 ──────────────────────────────────
async function getMe() {
  return apiFetch('/users/@me');
}

async function findDMChannel(target) {
  const channels = await apiFetch('/users/@me/channels');
  for (const ch of channels) {
    if (ch.type !== 1) continue;
    for (const r of ch.recipients ?? []) {
      if (r.username === target || r.id === target) {
        return { channelId: ch.id, recipient: r };
      }
    }
  }
  return null;
}

async function fetchAllMessages(channelId) {
  const messages = [];
  let before = null;

  while (true) {
    const params = { limit: 100 };
    if (before) params.before = before;

    const batch = await apiFetch(`/channels/${channelId}/messages`, params);
    if (!batch.length) break;

    messages.push(...batch);
    before = batch[batch.length - 1].id;
    setProgress(`메시지 수집 중... ${messages.length.toLocaleString()}개`);
    await sleep(400);
  }

  messages.sort((a, b) => a.id.localeCompare(b.id));
  return messages;
}

// ─── 내보내기 실행 ────────────────────────────────────────
async function runExport() {
  const target = userInput.value.trim();
  const formats = [...document.querySelectorAll('.formats input:checked')].map(el => el.value);

  if (!target || !formats.length) return;

  setError(null);
  setExporting(true);

  try {
    setProgress('내 계정 확인 중...');
    const me = await getMe();

    setProgress(`'${target}' 의 DM 채널 찾는 중...`);
    const found = await findDMChannel(target);
    if (!found) {
      throw new Error(`'${target}' 와의 DM 채널을 찾을 수 없습니다.\n유저명 또는 유저 ID를 확인하세요.`);
    }

    const { channelId, recipient } = found;

    setProgress('메시지 수집 중...');
    const messages = await fetchAllMessages(channelId);

    setProgress(`${messages.length.toLocaleString()}개 수집 완료. 파일 생성 중...`);

    const safe = target.replace(/[/\\:*?"<>|]/g, '_');

    if (formats.includes('json')) downloadJSON(messages, `dm_${safe}.json`);
    if (formats.includes('csv'))  downloadCSV(messages,  `dm_${safe}.csv`);
    if (formats.includes('txt'))  downloadTXT(messages,  `dm_${safe}.txt`);
    if (formats.includes('html')) downloadHTML(messages, recipient, me, `dm_${safe}.html`);

    setProgressDone(`완료! ${messages.length.toLocaleString()}개 메시지를 내보냈습니다.`);
  } catch (err) {
    setError(err.message);
    resetProgress();
  } finally {
    setExporting(false);
  }
}

function setExporting(active) {
  exportBtn.disabled = active;
  exportBtn.classList.toggle('loading', active);
  exportBtn.textContent = active ? '내보내는 중...' : '내보내기';
  progressEl.classList.toggle('hidden', !active);
  if (active) fillEl.style.animation = '';
}

function setProgress(msg) {
  textEl.textContent = msg;
}

function setProgressDone(msg) {
  fillEl.className = 'progress-fill done';
  textEl.textContent = msg;
  exportBtn.textContent = '내보내기';
  exportBtn.disabled = false;
}

function resetProgress() {
  progressEl.classList.add('hidden');
  fillEl.className = 'progress-fill';
}

function setError(msg) {
  errorEl.textContent = msg ?? '';
  errorEl.classList.toggle('hidden', !msg);
}

// ─── 파일 다운로드 헬퍼 ──────────────────────────────────
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: false }, () => {
    URL.revokeObjectURL(url);
  });
}

function fmtTs(ts) {
  return new Date(ts).toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

// ─── JSON ─────────────────────────────────────────────────
function downloadJSON(messages, filename) {
  downloadBlob(JSON.stringify(messages, null, 2), filename, 'application/json');
}

// ─── CSV ──────────────────────────────────────────────────
function downloadCSV(messages, filename) {
  const header = 'timestamp,author,content,attachments\n';
  const rows = messages.map(m => {
    const cells = [
      fmtTs(m.timestamp),
      m.author.username,
      m.content ?? '',
      (m.attachments ?? []).map(a => a.url).join(' | '),
    ].map(v => `"${String(v).replace(/"/g, '""')}"`);
    return cells.join(',');
  });
  downloadBlob('﻿' + header + rows.join('\n'), filename, 'text/csv;charset=utf-8');
}

// ─── TXT ──────────────────────────────────────────────────
function downloadTXT(messages, filename) {
  const lines = messages.map(m => {
    let line = `[${fmtTs(m.timestamp)}] ${m.author.username}: ${m.content ?? ''}`;
    for (const a of m.attachments ?? []) {
      line += `\n  [첨부] ${a.url}`;
    }
    return line;
  });
  downloadBlob(lines.join('\n'), filename, 'text/plain;charset=utf-8');
}

// ─── HTML ─────────────────────────────────────────────────
function downloadHTML(messages, recipient, me, filename) {
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  }

  function avatarUrl(author) {
    if (author.avatar) {
      return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=40`;
    }
    return `https://cdn.discordapp.com/embed/avatars/${Number(author.id) % 5}.png`;
  }

  const rows = messages.map(m => {
    const isMe = m.author.id === me.id;
    const ts = fmtTs(m.timestamp);
    const date = ts.slice(0, 10);

    const attachHtml = (m.attachments ?? []).map(a => {
      if ((a.content_type ?? '').startsWith('image/')) {
        return `<img src="${a.url}" class="att-img" loading="lazy" alt="image">`;
      }
      return `<a href="${a.url}" class="att-link" target="_blank">${esc(a.filename)}</a>`;
    }).join('');

    const embedHtml = (m.embeds ?? []).map(e => {
      const color = `#${(e.color ?? 0x5865F2).toString(16).padStart(6, '0')}`;
      return `<div class="embed" style="border-left-color:${color}">
        ${e.title ? `<div class="embed-title">${esc(e.title)}</div>` : ''}
        ${e.description ? `<div class="embed-desc">${esc(e.description)}</div>` : ''}
      </div>`;
    }).join('');

    return `<div class="${isMe ? 'msg msg-me' : 'msg'}" data-date="${date}">
      <img src="${avatarUrl(m.author)}" class="avatar" alt="">
      <div class="body">
        <div class="hdr">
          <span class="name">${esc(m.author.username)}</span>
          <span class="ts">${ts}</span>
        </div>
        <div class="content">${esc(m.content)}</div>
        ${attachHtml}${embedHtml}
      </div>
    </div>`;
  }).join('');

  const rname = esc(recipient?.username ?? 'Unknown');
  const total = messages.length;

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DM — ${rname}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#313338;color:#dcddde;font-family:'Segoe UI',Arial,sans-serif;font-size:15px}
.topbar{background:#1e1f22;padding:14px 20px;border-bottom:1px solid #111;
        position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px}
.topbar h1{font-size:16px;font-weight:700;color:#fff}
.topbar small{color:#949ba4;font-size:13px}
.searchbar{padding:10px 16px;background:#2b2d31;border-bottom:1px solid #1e1f22}
.searchbar input{width:100%;background:#1a1b1e;border:none;border-radius:4px;
                 padding:8px 12px;color:#dcddde;font-size:14px;outline:none}
.searchbar input::placeholder{color:#72767d}
.chat{max-width:900px;margin:0 auto;padding:16px}
.divider{display:flex;align-items:center;gap:8px;margin:14px 0}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:#3f4147}
.divider span{font-size:12px;color:#72767d;white-space:nowrap}
.msg{display:flex;gap:12px;padding:4px 8px;border-radius:4px}
.msg:hover{background:#2e3035}
.avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0;margin-top:2px}
.body{flex:1;min-width:0}
.hdr{display:flex;align-items:baseline;gap:8px;margin-bottom:2px}
.name{font-weight:700;color:#fff}
.ts{font-size:11px;color:#72767d}
.content{color:#dcddde;line-height:1.5;word-break:break-word}
.att-img{max-width:400px;max-height:300px;border-radius:4px;margin-top:6px;display:block}
.att-link{display:inline-block;margin-top:6px;color:#00aff4;font-size:13px;text-decoration:none}
.att-link:hover{text-decoration:underline}
.embed{border-left:4px solid #5865f2;background:#2b2d31;border-radius:4px;
       padding:10px 14px;margin-top:6px;max-width:520px}
.embed-title{font-weight:700;color:#fff;margin-bottom:4px}
.embed-desc{color:#dcddde;font-size:14px}
</style>
</head>
<body>
<div class="topbar">
  <div>
    <h1>@ ${rname} 와의 DM</h1>
    <small>총 ${total.toLocaleString()}개 메시지</small>
  </div>
</div>
<div class="searchbar">
  <input id="q" type="text" placeholder="메시지 검색..." oninput="search(this.value)">
</div>
<div class="chat" id="chat">${rows}</div>
<script>
(function(){
  const msgs=[...document.querySelectorAll('.msg')];
  let last='';
  msgs.forEach(m=>{
    const d=m.dataset.date;
    if(d!==last){
      const el=document.createElement('div');
      el.className='divider';
      el.innerHTML='<span>'+d+'</span>';
      m.before(el);
      last=d;
    }
  });
  window.search=q=>{
    q=q.toLowerCase();
    msgs.forEach(m=>{
      const ok=!q
        ||m.querySelector('.content')?.textContent.toLowerCase().includes(q)
        ||m.querySelector('.name')?.textContent.toLowerCase().includes(q);
      m.style.display=ok?'':'none';
    });
  };
  window.scrollTo(0,document.body.scrollHeight);
})();
<\/script>
</body>
</html>`;

  downloadBlob(html, filename, 'text/html;charset=utf-8');
}
