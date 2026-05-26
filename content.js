// content.js - Discord 탭의 격리 컨텍스트에서 실행
// injected.js(MAIN world)와 postMessage로 통신해 토큰을 받아옴

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'GET_TOKEN') return;

  const handler = event => {
    if (event.source !== window || event.data?.type !== 'DISCORD_TOKEN_RESULT') return;
    window.removeEventListener('message', handler);
    clearTimeout(timeout);
    sendResponse({ token: event.data.token });
  };

  // 3초 내에 응답이 없으면 실패 처리
  const timeout = setTimeout(() => {
    window.removeEventListener('message', handler);
    sendResponse({ token: null });
  }, 3000);

  window.addEventListener('message', handler);
  window.postMessage({ type: 'DISCORD_GET_TOKEN' }, '*');

  return true; // 비동기 sendResponse 유지
});
