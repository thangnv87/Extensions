/* Podhub GPTs - Gemini Automation
   - Auto-upload image to Gemini
   - Send custom merch-remaster prompts
   - Extract up to 2K image result
   - Push to PodHub for BG Removal & 4K Upscale
*/
(function () {
  'use strict';
  if (document.getElementById('phb-root-gemini')) return;

  const VERSION = '1.0.66';
  const PODHUB_ORIGIN = 'https://ex.podhub.space';
  let isRunning = false;
  let currentJob = null;

  // ============ API HELPERS (Adapted from chatgpt.js) ============
  function getOrigin() { return PODHUB_ORIGIN; }
  function getQueueApi() { return getOrigin() + '/api/ext-queue'; }

  async function getExtensionToken() {
    return new Promise(resolve => {
      try {
        if (!chrome?.storage?.local) return resolve(localStorage.getItem('phb_jwt_token') || '');
        chrome.storage.local.get(['phb_jwt_token'], data => {
          resolve(data?.phb_jwt_token || localStorage.getItem('phb_jwt_token') || '');
        });
      } catch (e) { resolve(''); }
    });
  }

  // ============ HARDWARE FINGERPRINT (Device Binding) ============
  let cachedMachineId = null;
  async function getMachineFingerprint() {
    try {
      if (cachedMachineId) return cachedMachineId;
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      let gpu = 'unknown_gpu';
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) gpu = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || gpu;
      }
      const components = [
        navigator.platform || '',
        navigator.hardwareConcurrency || '',
        navigator.deviceMemory || '',
        screen.width + 'x' + screen.height + 'x' + (screen.colorDepth || ''),
        gpu
      ];
      const rawString = components.join('###');
      const msgBuffer = new TextEncoder().encode(rawString);
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      cachedMachineId = 'PC_' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 24);
      return cachedMachineId;
    } catch(e) {
      cachedMachineId = 'PC_FB_' + (navigator.userAgent.length + screen.width);
      return cachedMachineId;
    }
  }

  async function requestJson(url, options = {}) {
    const token = await getExtensionToken();
    if (token) {
      options.headers = { ...(options.headers || {}), 'Authorization': 'Bearer ' + token };
    }
    const machineId = await getMachineFingerprint();
    options.headers = { ...(options.headers || {}), 'X-Machine-ID': machineId };
    const r = await fetch(url, options);
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && (data?.error === 'SESSION_KICKED' || /thiết bị khác|device/i.test(data?.message || ''))) {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove('phb_jwt_token');
      }
      localStorage.removeItem('phb_jwt_token');
      alert('🚨 Tài khoản của bạn đã được đăng nhập trên một thiết bị/máy tính khác! Bạn đã bị đăng xuất.');
      window.location.reload();
      throw new Error('SESSION_KICKED');
    }
    if (!r.ok) throw new Error(data?.error || r.statusText || 'HTTP ' + r.status);
    return data;
  }
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const apiGet = (p) => requestJson(getQueueApi() + p);
  const apiPost = (p, b) => requestJson(getQueueApi() + p, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(b) });

  // ============ UI INJECTION ============
  function injectUI() {
    const root = document.createElement('div');
    root.id = 'phb-root-gemini';
    root.style.cssText = 'position:fixed; top:10px; right:10px; width:300px; background:#1e293b; color:white; border:1px solid #334155; border-radius:8px; z-index:999999; font-family:sans-serif; font-size:13px; box-shadow:0 4px 12px rgba(0,0,0,0.5); padding:10px;';
    
    root.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #334155; padding-bottom:8px; margin-bottom:10px;">
        <strong style="color:#818cf8;">Podhub Gemini Auto</strong>
        <span id="phb-status" style="background:#475569; padding:2px 6px; border-radius:4px; font-size:11px;">IDLE</span>
      </div>
      <div style="margin-bottom:10px;">
        <button id="phb-btn-start" style="width:100%; padding:6px; background:#4f46e5; color:white; border:none; border-radius:4px; cursor:pointer;">Start Auto (Queue)</button>
        <button id="phb-btn-stop" style="width:100%; padding:6px; background:#ef4444; color:white; border:none; border-radius:4px; cursor:pointer; display:none; margin-top:5px;">Stop</button>
      </div>
      <div id="phb-log" style="height:150px; overflow-y:auto; background:#0f172a; padding:5px; border-radius:4px; font-family:monospace; font-size:11px; color:#cbd5e1;">
        --- Logs ---<br/>
      </div>
    `;
    document.body.appendChild(root);

    document.getElementById('phb-btn-start').onclick = () => {
      isRunning = true;
      document.getElementById('phb-btn-start').style.display = 'none';
      document.getElementById('phb-btn-stop').style.display = 'block';
      setStatus('POLLING', '#eab308');
      log('Bắt đầu lấy Job từ Queue...');
      pollJobs();
    };

    document.getElementById('phb-btn-stop').onclick = () => {
      isRunning = false;
      document.getElementById('phb-btn-start').style.display = 'block';
      document.getElementById('phb-btn-stop').style.display = 'none';
      setStatus('STOPPED', '#ef4444');
      log('Đã dừng tự động.');
    };
  }

  function log(msg) {
    const el = document.getElementById('phb-log');
    if (!el) return;
    const time = new Date().toLocaleTimeString();
    el.innerHTML += `[${time}] ${msg}<br/>`;
    el.scrollTop = el.scrollHeight;
  }

  function setStatus(text, color) {
    const el = document.getElementById('phb-status');
    if (el) {
      el.textContent = text;
      el.style.backgroundColor = color;
    }
  }

  // ============ GEMINI DOM AUTOMATION ============
  
  // Hàm này giả lập việc upload ảnh bằng cách tạo File object và ném vào input
  async function uploadImageToGemini(imageUrl) {
    log('Đang tải ảnh từ: ' + imageUrl);
    try {
      const res = await fetch(imageUrl);
      const blob = await res.blob();
      const file = new File([blob], "mockup.jpg", { type: blob.type });

      // CÁCH 1: Tìm input file ẩn (Cách này cần mò DOM của Gemini, class thường đổi liên tục)
      const fileInput = document.querySelector('input[type="file"]');
      if (fileInput) {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
        
        // Kích hoạt sự kiện change
        const event = new Event('change', { bubbles: true });
        fileInput.dispatchEvent(event);
        log('Đã attach ảnh qua input file.');
        return true;
      }

      // CÁCH 2: Phóng event paste vào thẻ chatbox.
      const chatBox = document.querySelector('rich-textarea') || document.querySelector('[contenteditable="true"]');
      if (chatBox) {
        log('Thử paste ảnh vào chatbox...');
        const dt = new DataTransfer();
        dt.items.add(file);
        const pasteEvent = new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true
        });
        chatBox.dispatchEvent(pasteEvent);
        return true;
      }
      
      log('Không tìm thấy vùng upload ảnh trên Gemini!');
      return false;
    } catch (e) {
      log('Lỗi tải ảnh: ' + e.message);
      return false;
    }
  }

  async function sendPrompt(promptText) {
    const chatBox = document.querySelector('rich-textarea') || document.querySelector('[contenteditable="true"]');
    if (!chatBox) {
      log('Không tìm thấy ô nhập text!');
      return false;
    }
    
    // Gõ text
    chatBox.focus();
    document.execCommand('insertText', false, promptText);
    
    // Tìm nút gửi
    const sendBtn = document.querySelector('button[aria-label*="end message"]') || 
                    Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Send') || b.querySelector('mat-icon')?.innerText === 'send');
                    
    if (sendBtn) {
      await new Promise(r => setTimeout(r, 1000)); // Đợi upload ảnh xong
      sendBtn.click();
      log('Đã gửi prompt!');
      return true;
    }
    log('Không tìm thấy nút Send!');
    return false;
  }

  // Chờ Gemini sinh xong ảnh
  async function waitForResponseAndExtractImage() {
    log('Đang chờ Gemini trả ảnh...');
    return new Promise((resolve) => {
      let attempts = 0;
      const interval = setInterval(() => {
        if (!isRunning) {
          clearInterval(interval);
          resolve(null);
        }
        attempts++;
        if (attempts > 60) { // Timeout 2 phút
          clearInterval(interval);
          log('Timeout khi chờ ảnh.');
          resolve(null);
        }

        const isGenerating = document.querySelector('button[aria-label*="top generating"]') !== null;
        if (isGenerating) return; // Vẫn đang chạy

        // Lấy thẻ div chứa kết quả cuối cùng
        const messageBlocks = document.querySelectorAll('message-content');
        if (messageBlocks.length > 0) {
          const lastBlock = messageBlocks[messageBlocks.length - 1];
          const allImgs = Array.from(lastBlock.querySelectorAll('img')).filter(i => i.src && i.src.includes('googleusercontent'));
          if (allImgs.length > 0) {
            clearInterval(interval);
            const finalImg = allImgs[0].src;
            log('Đã bắt được link ảnh: ' + finalImg.substring(0, 30) + '...');
            resolve(finalImg);
          }
        }
      }, 2000);
    });
  }

  // ============ JOB LOOP ============
  async function pollJobs() {
    if (!isRunning) return;
    try {
      // Giả lập logic gọi API (cần ráp đúng endpoint của Podhub-GPTs)
      // Khi đã ghép hoàn thiện, ta sẽ lấy job, gọi uploadImageToGemini, sendPrompt, rồi post kết quả.
      log('Polling... (chưa kích hoạt API thật)');
      await new Promise(r => setTimeout(r, 5000));
      pollJobs();
    } catch (e) {
      log('Lỗi polling: ' + e.message);
      await new Promise(r => setTimeout(r, 5000));
      pollJobs();
    }
  }

  // Khởi tạo
  window.addEventListener('load', () => {
    setTimeout(injectUI, 1000);
  });

})();
