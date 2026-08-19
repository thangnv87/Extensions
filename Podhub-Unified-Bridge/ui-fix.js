(() => {
  "use strict";

  const PRICING_URL = "https://tools.podhub.space/pricing";
  let isSyncing = false;
  let isApplying = false;

  const make = (className, text) => {
    const element = document.createElement("div");
    element.className = className;
    if (text) element.textContent = text;
    return element;
  };

  const removeLegacyLabel = element => {
    const label = element?.previousElementSibling;
    if (label?.tagName === "LABEL") label.remove();
  };

  const prepareSaveButton = (panel, source) => {
    const button = source?.querySelector?.('[data-action="save-settings"]') || source;
    if (!button) return null;
    button.hidden = false;
    button.textContent = "Lưu cấu hình";
    button.classList.add("pub-panel-save");
    return button;
  };

  function arrangeRedesign(panel) {
    if (!panel || panel.dataset.uiUnified === "1") return false;

    const flow = panel.querySelector(".pub-flow-text");
    const countRow = panel.querySelector('[data-role="redesign-count-field"].pub-field-row');
    const countLabel = panel.querySelector('label[data-role="redesign-count-field"]');
    const autoStyle = panel.querySelector("#pub-redesign-auto-style")?.closest("label");
    const styleGrid = panel.querySelector("#pub-redesign-style-grid");
    const customStyle = panel.querySelector("#pub-redesign-custom-style")?.closest(".pub-add-row");
    const marketGrid = panel.querySelector("#pub-redesign-market-grid");
    const productGrid = panel.querySelector("#pub-redesign-product-grid");
    const customProduct = panel.querySelector("#pub-redesign-custom-product")?.closest(".pub-add-row");
    if (!flow || !countRow || !autoStyle || !styleGrid || !customStyle || !marketGrid || !productGrid || !customProduct) return false;

    const saveButton = prepareSaveButton(panel, countRow);
    countRow.classList.add("pub-single-field");
    const oldDivider = panel.querySelector(".pub-divider");
    const oldSectionTitle = panel.querySelector(".pub-section-title");
    oldDivider?.remove();
    oldSectionTitle?.remove();
    removeLegacyLabel(styleGrid);
    removeLegacyLabel(productGrid);

    if (countLabel) countLabel.textContent = "Số lượng redesign";

    const settingsTitle = make("pub-section-title", "Thiết lập Redesign");
    const presetLabel = make("pub-subsection-title", "Style có sẵn từ server");
    const customStyleLabel = make("pub-subsection-title", "Style tự nhập thêm");
    const listingDivider = make("pub-divider");
    const listingTitle = make("pub-section-title", "Tạo Listing cho sàn");
    const listingNote = make("pub-section-note", "Chọn sàn và sản phẩm để nội dung Listing chuẩn SEO, đúng ngữ cảnh hơn.");
    const productLabel = make("pub-subsection-title", "Sản phẩm cho Listing");

    panel.replaceChildren(
      flow,
      settingsTitle,
      ...(countLabel ? [countLabel] : []),
      countRow,
      autoStyle,
      presetLabel,
      styleGrid,
      customStyleLabel,
      customStyle,
      listingDivider,
      listingTitle,
      listingNote,
      marketGrid,
      productLabel,
      productGrid,
      customProduct,
      ...(saveButton ? [saveButton] : [])
    );
    panel.dataset.uiUnified = "1";
    return true;
  }

  function arrangeMockup(panel) {
    if (!panel || panel.dataset.uiUnified === "1") return false;

    const flow = panel.querySelector(".pub-flow-text");
    const quickSettings = panel.querySelector(".pub-mockup-quick-row");
    const productGrid = panel.querySelector("#pub-product-grid");
    const marketGrid = panel.querySelector("#pub-mockup-market-grid");
    const customProduct = panel.querySelector("#pub-mockup-custom-product")?.closest(".pub-add-row");
    if (!flow || !quickSettings || !productGrid || !marketGrid || !customProduct) return false;

    const saveButton = prepareSaveButton(panel, quickSettings);
    removeLegacyLabel(productGrid);
    removeLegacyLabel(marketGrid);

    const productTitle = make("pub-section-title", "Sản phẩm cần tạo Mockup");
    const listingDivider = make("pub-divider");
    const listingTitle = make("pub-section-title", "Tạo Listing cho sàn");
    const listingNote = make("pub-section-note", "Chọn các sàn cần tạo nội dung Listing sau khi hoàn tất Mockup.");

    panel.replaceChildren(
      flow,
      productTitle,
      quickSettings,
      productGrid,
      customProduct,
      listingDivider,
      listingTitle,
      listingNote,
      marketGrid,
      ...(saveButton ? [saveButton] : [])
    );
    panel.dataset.uiUnified = "1";
    return true;
  }

  // --- UPSELL MODAL ---
  function showUpsellModal(tabId, planName) {
    const root = document.querySelector("#pub-root");
    if (!root) return;

    root.querySelector(".pub-upsell-backdrop")?.remove();

    const moduleNames = {
      clone: "Clone GPTs",
      redesign: "Redesign GPTs",
      mockup: "Mockup GPTs"
    };
    const targetModuleName = moduleNames[tabId] || tabId;
    const currentPlanText = planName || "Clone GPTs";

    const backdrop = document.createElement("div");
    backdrop.className = "pub-upsell-backdrop";
    backdrop.innerHTML = `
      <div class="pub-upsell-modal">
        <div class="pub-upsell-icon">🔒</div>
        <h3 class="pub-upsell-title">Mở khóa ${targetModuleName}</h3>
        <p class="pub-upsell-desc">Gói của bạn gồm: <b>${currentPlanText}</b> — Nâng cấp Pro để mở khóa toàn bộ.</p>
        <div class="pub-upsell-actions">
          <button type="button" class="pub-btn-pricing">Xem bảng giá nâng cấp →</button>
          <button type="button" class="pub-btn-close-modal">Đóng</button>
        </div>
      </div>
    `;

    backdrop.querySelector(".pub-btn-pricing")?.addEventListener("click", () => {
      window.open(PRICING_URL, "_blank");
      backdrop.remove();
    });

    backdrop.querySelector(".pub-btn-close-modal")?.addEventListener("click", () => {
      backdrop.remove();
    });

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });

    root.appendChild(backdrop);
  }

  // --- LOCK AND LICENSE STATE SYNC (SAFE & DEBOUNCED) ---
  async function syncLicenseAndLockStates() {
    if (isSyncing) return;
    isSyncing = true;

    try {
      const root = document.querySelector("#pub-root");
      if (!root || typeof chrome === "undefined" || !chrome.storage?.local) return;

      const data = await chrome.storage.local.get([
        "pub_license_token",
        "pub_license_user",
        "pub_runtime_config"
      ]);

      const token = data.pub_license_token;
      const user = data.pub_license_user;
      const config = data.pub_runtime_config;

      // 1. Determine allowed modules & Plan Name
      const modulesConfig = config?.modules || {};
      let allowedModules = [];

      const rawModules = user?.allowed_modules || user?.modules || config?.allowed_modules || [];
      const planId = String(user?.plan_id || "").toLowerCase();

      if (Array.isArray(rawModules) && rawModules.length > 0) {
        if (rawModules.includes("all") || rawModules.length >= 3) {
          allowedModules = ["clone", "redesign", "mockup"];
        } else {
          allowedModules = rawModules.map(m => {
            const s = String(m).toLowerCase();
            if (s.includes("clone")) return "clone";
            if (s.includes("redesign")) return "redesign";
            if (s.includes("mockup")) return "mockup";
            return s;
          });
        }
      } else if (config?.modules) {
        for (const [key, m] of Object.entries(modulesConfig)) {
          if (m && (m.enabled === true || m.allowed === true)) {
            allowedModules.push(key);
          }
        }
      }

      if (token && allowedModules.length === 0) {
        allowedModules = ["clone"];
      }

      let currentPlanName = user?.plan_name || "POD Pro Bundle";
      if (!user?.plan_name) {
        if (allowedModules.includes("clone") && allowedModules.includes("redesign") && allowedModules.includes("mockup")) {
          currentPlanName = planId.includes("studio") ? "POD Studio" : "POD Pro Bundle";
        } else if (allowedModules.includes("clone")) {
          currentPlanName = "Clone GPTs";
        } else if (allowedModules.includes("redesign")) {
          currentPlanName = "Redesign GPTs";
        } else if (allowedModules.includes("mockup")) {
          currentPlanName = "Mockup GPTs";
        }
      }

      // 2. Sync Active state & Formatted Account String
      const statusEl = root.querySelector(".pub-account-status");
      const userIdentifier = user?.email || user?.username || "Tài khoản Podhub";
      if (token) {
        if (!root.classList.contains("license-active")) root.classList.add("license-active");
        if (statusEl) {
          if (!statusEl.classList.contains("active")) statusEl.classList.add("active");
          const targetText = `${currentPlanName} · Active · ${userIdentifier}`;
          if (statusEl.textContent !== targetText) statusEl.textContent = targetText;
        }
      } else {
        if (root.classList.contains("license-active")) root.classList.remove("license-active");
        if (statusEl) {
          if (statusEl.classList.contains("active")) statusEl.classList.remove("active");
          if (statusEl.textContent !== "Chưa kích hoạt license") statusEl.textContent = "Chưa kích hoạt license";
        }
      }

      // 3. Attach Lock Icons & Interceptors to Tabs
      const tabs = root.querySelectorAll(".pub-tabs .pub-tab, .pub-tab");
      tabs.forEach(tab => {
        const text = tab.textContent.replace(/🔒/g, "").trim().toLowerCase();
        let tabModule = "";
        if (text.includes("clone")) tabModule = "clone";
        else if (text.includes("redesign")) tabModule = "redesign";
        else if (text.includes("mockup")) tabModule = "mockup";
        if (!tabModule) return;

        const isAllowed = !token || allowedModules.includes(tabModule);

        if (!isAllowed) {
          if (!tab.classList.contains("pub-tab-locked")) tab.classList.add("pub-tab-locked");
          if (!tab.querySelector(".pub-lock-icon")) {
            const lockIcon = document.createElement("span");
            lockIcon.className = "pub-lock-icon";
            lockIcon.textContent = "🔒";
            tab.appendChild(lockIcon);
          }

          if (!tab.dataset.lockListenerAttached) {
            tab.dataset.lockListenerAttached = "1";
            tab.addEventListener(
              "click",
              (e) => {
                if (tab.classList.contains("pub-tab-locked")) {
                  e.preventDefault();
                  e.stopImmediatePropagation();
                  if (e.target && e.target.classList.contains("pub-lock-icon")) {
                    showUpsellModal(tabModule, currentPlanName);
                  }
                }
              },
              true
            );
          }
        } else {
          if (tab.classList.contains("pub-tab-locked")) tab.classList.remove("pub-tab-locked");
          tab.querySelector(".pub-lock-icon")?.remove();
        }
      });
    } finally {
      isSyncing = false;
    }
  }

  function applyUiFix() {
    if (isApplying) return;
    isApplying = true;

    try {
      const root = document.querySelector("#pub-root");
      if (!root) return;

      const activateButton = root.querySelector('[data-action="activate"]');
      if (activateButton && activateButton.textContent !== "Kích hoạt") {
        activateButton.textContent = "Kích hoạt";
        activateButton.title = "Kích hoạt license Podhub";
      }

      const logoutButton = root.querySelector('[data-action="deactivate"]');
      if (logoutButton && logoutButton.textContent !== "Đăng xuất") {
        logoutButton.textContent = "Đăng xuất";
        logoutButton.classList.add("pub-btn", "secondary", "pub-btn-logout");
        logoutButton.title = "Đăng xuất khỏi tài khoản Podhub";
      }

      root.querySelectorAll('.pub-field-row [data-action="save-settings"]').forEach(button => {
        if (!button.closest(".pub-config-panel") && button.textContent !== "Lưu") button.textContent = "Lưu";
      });

      const redesignReady = arrangeRedesign(root.querySelector('[data-config-panel="redesign"]'));
      const mockupReady = arrangeMockup(root.querySelector('[data-config-panel="mockup"]'));

      syncLicenseAndLockStates().catch(() => {});

      if (redesignReady && mockupReady) {
        observer.disconnect();
      }
    } finally {
      isApplying = false;
    }
  }

  // --- STORAGE & RUNTIME LISTENERS ---
  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") {
        if (changes.pub_license_token || changes.pub_license_user || changes.pub_runtime_config) {
          syncLicenseAndLockStates().catch(() => {});
        }
      }
    });
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "PUB_LICENSE_UPDATED" || message?.type === "LICENSE_UPDATED") {
        syncLicenseAndLockStates().catch(() => {});
      }
    });
  }

  // Observe only until #pub-root is attached and configured, then disconnect
  const observer = new MutationObserver(() => {
    applyUiFix();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  applyUiFix();
})();
