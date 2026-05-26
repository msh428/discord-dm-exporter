// background.js - MV3 service worker (최소 구성)

chrome.runtime.onInstalled.addListener(() => {
  console.log('Discord DM Exporter installed');
});
