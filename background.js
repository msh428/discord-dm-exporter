// Discord가 실제로 보내는 API 요청을 가로채서 Authorization 토큰 추출

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const auth = details.requestHeaders?.find(
      h => h.name.toLowerCase() === 'authorization'
    );
    if (auth?.value && !auth.value.startsWith('Bot ')) {
      chrome.storage.session.set({ discordToken: auth.value });
    }
  },
  { urls: ['https://discord.com/api/*'] },
  ['requestHeaders', 'extraHeaders']
);
