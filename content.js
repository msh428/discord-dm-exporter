// content.js - discord.com 탭에서 실행됨

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_TOKEN') {
    const token = localStorage.getItem('token');
    sendResponse({ token: token || null });
    return true;
  }
});
