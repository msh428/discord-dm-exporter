'use strict';

const DISCORD_API = 'https://discord.com/api/v9';

// ── 토큰 캡처 ─────────────────────────────────────────────
chrome.webRequest.onSendHeaders.addListener(
  details => {
    const auth = details.requestHeaders?.find(h => h.name.toLowerCase() === 'authorization');
    if (auth?.value && !auth.value.startsWith('Bot ')) {
      chrome.storage.session.set({ discordToken: auth.value });
    }
  },
  { urls: ['https://discord.com/api/*'] },
  ['requestHeaders', 'extraHeaders']
);

// ── 상태 ─────────────────────────────────────────────────
let abortController = null;

// ── 메시지 핸들러 ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_EXPORT') {
    handleExport(msg.params).catch(e => {
      if (e.name !== 'AbortError') setStatus({ status: 'error', message: e.message });
    });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'CANCEL_EXPORT') {
    abortController?.abort();
    setStatus({ status: 'cancelled' });
    setBadge('', null);
    sendResponse({ ok: true });
    return true;
  }
});

// ── 내보내기 메인 ─────────────────────────────────────────
async function handleExport({ items, formats, dateFrom, dateTo }) {
  const { discordToken: token } = await chrome.storage.session.get('discordToken');
  if (!token) { setStatus({ status: 'error', message: '토큰이 없습니다.' }); return; }

  abortController = new AbortController();
  const { signal } = abortController;
  const startTime = Date.now();

  setBadge('↓', '#5865F2');
  setStatus({ status: 'running', message: '준비 중...', startTime, batchTotal: items.length, batchCurrent: 1 });

  const me = await apiFetch('/users/@me', {}, token, signal);
  let totalMsgs = 0;

  for (let i = 0; i < items.length; i++) {
    if (signal.aborted) break;
    const { channelId, channelName, recipient } = items[i];

    setStatus({
      status: 'running', startTime,
      batchTotal: items.length, batchCurrent: i + 1,
      channelName, message: '메시지 수집 중...', count: 0,
    });

    const messages = await fetchAllMessages(channelId, dateFrom, dateTo, token, signal, count => {
      setStatus({
        status: 'running', startTime,
        batchTotal: items.length, batchCurrent: i + 1,
        channelName, message: `메시지 수집 중... ${count.toLocaleString()}개`, count,
      });
    });

    if (signal.aborted) break;

    setStatus({
      status: 'running', startTime,
      batchTotal: items.length, batchCurrent: i + 1,
      channelName, message: '파일 생성 중...', count: messages.length,
    });

    const safe = channelName.replace(/[/\\:*?"<>|]/g, '_');
    if (formats.includes('json')) await dl(JSON.stringify(messages, null, 2), `dm_${safe}.json`, 'application/json');
    if (formats.includes('csv'))  await dl(buildCSV(messages),  `dm_${safe}.csv`,  'text/csv;charset=utf-8');
    if (formats.includes('txt'))  await dl(buildTXT(messages),  `dm_${safe}.txt`,  'text/plain;charset=utf-8');
    if (formats.includes('html')) await dl(buildHTML(messages, recipient, me, channelName), `dm_${safe}.html`, 'text/html;charset=utf-8');

    totalMsgs += messages.length;
  }

  if (!signal.aborted) {
    const doneMsg = items.length > 1
      ? `${items.length}개 DM, 총 ${totalMsgs.toLocaleString()}개 메시지 완료`
      : `${totalMsgs.toLocaleString()}개 메시지 완료`;

    setStatus({ status: 'done', message: '✓ ' + doneMsg });
    setBadge('✓', '#3ba55c');

    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title: 'Discord DM Exporter',
      message: doneMsg,
    });

    setTimeout(() => { setBadge('', null); setStatus({ status: 'idle' }); }, 5000);
  }
}

// ── 상태 저장 ─────────────────────────────────────────────
function setStatus(data) {
  chrome.storage.session.set({ exportStatus: data });
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

// ── Discord API ───────────────────────────────────────────
async function apiFetch(path, params = {}, token, signal = null) {
  const url = new URL(DISCORD_API + path);
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
  throw new Error('Rate limit 재시도 초과');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchAllMessages(channelId, fromDate, toDate, token, signal, onProgress) {
  const messages = [];
  let before = null;
  const fromTs = fromDate ? new Date(fromDate + 'T00:00:00+09:00').getTime() : null;
  const toTs   = toDate   ? new Date(toDate   + 'T23:59:59+09:00').getTime() : null;

  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const params = { limit: 100 };
    if (before) params.before = before;
    const batch = await apiFetch(`/channels/${channelId}/messages`, params, token, signal);
    if (!batch.length) break;
    let stop = false;
    for (const m of batch) {
      const ts = new Date(m.timestamp).getTime();
      if (toTs && ts > toTs) continue;
      if (fromTs && ts < fromTs) { stop = true; break; }
      messages.push(m);
    }
    before = batch[batch.length - 1].id;
    onProgress?.(messages.length);
    await sleep(380);
    if (stop || batch.length < 100) break;
  }
  messages.sort((a, b) => a.id.localeCompare(b.id));
  return messages;
}

// ── 파일 다운로드 ─────────────────────────────────────────
function dl(content, filename, mime) {
  return new Promise(resolve => {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: false }, () => {
      URL.revokeObjectURL(url);
      resolve();
    });
  });
}

// ── CSV / TXT 생성 ────────────────────────────────────────
function fmtTs(ts) {
  return new Date(ts).toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function buildCSV(messages) {
  const header = 'timestamp,author,content,attachments\n';
  const rows = messages.map(m =>
    [fmtTs(m.timestamp), m.author.username, m.content ?? '',
     (m.attachments ?? []).map(a => a.url).join(' | ')]
      .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
  );
  return '﻿' + header + rows.join('\n');
}

function buildTXT(messages) {
  return messages.map(m => {
    let line = `[${fmtTs(m.timestamp)}] ${m.author.username}: ${m.content ?? ''}`;
    (m.attachments ?? []).forEach(a => { line += `\n  [첨부] ${a.url}`; });
    return line;
  }).join('\n');
}

// ── HTML 생성 ─────────────────────────────────────────────
function buildHTML(messages, recipient, me, channelName) {
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

  const rname = escH(channelName);
  const total = messages.length;

  return `<!DOCTYPE html>
<html lang="ko" data-theme="dark">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DM — ${rname}</title>
<style>
:root{--bg:#313338;--bg2:#2b2d31;--bg3:#1e1f22;--text:#dcddde;--text2:#b5bac1;--muted:#80848e;--accent:#5865f2;--border:#3c3f44;--hover:#2e3035}
[data-theme="light"]{--bg:#fff;--bg2:#f2f3f5;--bg3:#e3e5e8;--text:#2e3338;--text2:#4e5058;--muted:#80848e;--border:#d4d7dc;--hover:#f2f3f5}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',-apple-system,sans-serif;font-size:15px}
.toolbar{background:var(--bg3);border-bottom:1px solid var(--border);padding:12px 20px;position:sticky;top:0;z-index:100;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.toolbar-info h1{font-size:16px;font-weight:700;color:var(--text)}
.toolbar-info small{font-size:12px;color:var(--muted)}
.toolbar-controls{display:flex;align-items:center;gap:8px;margin-left:auto}
.search-input{background:var(--bg2);border:1.5px solid var(--border);border-radius:6px;padding:6px 12px;color:var(--text);font-size:13px;outline:none;width:180px}
.search-input:focus{border-color:var(--accent)}
.search-input::placeholder{color:var(--muted)}
.search-count{font-size:12px;color:var(--muted);min-width:30px}
.theme-btn{background:var(--bg2);border:1.5px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text2);cursor:pointer;font-size:14px}
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
.scroll-btn{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:8px 12px;cursor:pointer;color:var(--text2);font-size:14px;box-shadow:0 2px 8px #00000040}
.scroll-btn:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
</style></head>
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
  msgs.forEach(m=>{const d=m.dataset.date;if(d&&d!==last){const el=document.createElement('div');el.className='divider';el.innerHTML='<span>'+d+'</span>';m.before(el);last=d;}});
  window.doSearch=function(q){const lq=q.toLowerCase().trim();let n=0;msgs.forEach(m=>{if(!lq){m.classList.remove('hidden','highlight');return;}const ok=(m.querySelector('.content')?.textContent??'').toLowerCase().includes(lq)||(m.querySelector('.name')?.textContent??'').toLowerCase().includes(lq);m.classList.toggle('hidden',!ok);m.classList.toggle('highlight',ok);if(ok)n++;});document.getElementById('sc').textContent=lq?n+'개':'';};
  window.toggleTheme=function(){const h=document.documentElement,dark=h.dataset.theme!=='light';h.dataset.theme=dark?'light':'dark';document.querySelector('.theme-btn').textContent=dark?'☀️':'🌙';};
  window.scrollTo(0,document.body.scrollHeight);
})();
<\/script>
</body></html>`;
}
