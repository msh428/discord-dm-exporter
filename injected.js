// 페이지의 실제 JS 컨텍스트(MAIN world)에서 실행 — Discord webpack 모듈에서 토큰 추출

window.addEventListener('message', event => {
  if (event.source !== window || event.data?.type !== 'DISCORD_GET_TOKEN') return;

  let token = null;

  // Discord 내부 webpack 모듈에서 토큰 추출 (가장 신뢰할 수 있는 방법)
  try {
    const chunk = window.webpackChunkdiscord_app;
    if (chunk) {
      chunk.push([[Math.random()], {}, req => {
        for (const id in req.c) {
          const mod = req.c[id]?.exports;
          if (mod?.default?.getToken) {
            token = mod.default.getToken();
            break;
          }
          // 일부 버전에서 exports 자체에 getToken이 있는 경우
          if (mod?.getToken) {
            token = mod.getToken();
            break;
          }
        }
      }]);
      chunk.pop();
    }
  } catch {}

  // 폴백: localStorage에서 직접 읽기
  if (!token) {
    try {
      const raw = localStorage.getItem('token');
      if (raw) token = raw.replace(/^"|"$/g, '');
    } catch {}
  }

  window.postMessage({ type: 'DISCORD_TOKEN_RESULT', token: token ?? null }, '*');
});
