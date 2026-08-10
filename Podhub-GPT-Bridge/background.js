'use strict';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'PODHUB_ENSURE_ORIGIN_PERMISSION') return false;
  let origin = '';
  try {
    const parsed = new URL(String(message.origin || ''));
    if (parsed.protocol !== 'https:') throw new Error('HTTPS_REQUIRED');
    origin = parsed.origin + '/*';
  } catch {
    sendResponse({granted:false, error:'INVALID_ORIGIN'});
    return false;
  }

  chrome.permissions.contains({origins:[origin]}, alreadyGranted => {
    if (alreadyGranted) {
      sendResponse({granted:true});
      return;
    }
    chrome.permissions.request({origins:[origin]}, granted => {
      sendResponse({
        granted:Boolean(granted),
        error:chrome.runtime.lastError?.message || null
      });
    });
  });
  return true;
});
