(() => {
  "use strict";

  const PRICING_URL = "https://ex.podhub.space/pricing";
  const ALL_MODULES = ["clone", "redesign", "mockup"];
  let licenseSyncing = false;
  let licenseStatusObserver;
  let marketplaceRefreshTimer;
  let marketplacePollingTimer;
  let licenseConfigRefreshTimer;
  let dashboardRequestChecking = false;
  let fallbackJobsRequest = 0;

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
    if (!flow || !countRow || !autoStyle || !styleGrid || !customStyle || !marketGrid) return false;

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
      ...(productGrid ? [productLabel, productGrid] : []),
      ...(customProduct ? [customProduct] : []),
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

  const normalizeModuleId = value => {
    const text = String(value?.id || value?.module_id || value || "").toLowerCase();
    if (text.includes("clone")) return "clone";
    if (text.includes("redesign") || text.includes("multiplier")) return "redesign";
    if (text.includes("mockup")) return "mockup";
    return "";
  };

  function getLicenseAccess(user, config, hasToken) {
    const configuredModules = Array.isArray(config?.allowed_modules) ? config.allowed_modules : null;
    const enabledConfigModules = config?.modules && !Array.isArray(config.modules)
      ? Object.values(config.modules).filter(module => module?.enabled === true)
      : [];
    const rawModules = configuredModules ?? (
      user?.allowed_modules || user?.module_ids || user?.modules || user?.features?.modules ||
      config?.entitlements?.modules || enabledConfigModules
    );
    let allowedModules = Array.isArray(rawModules)
      ? rawModules.map(normalizeModuleId).filter(Boolean)
      : [];

    const planText = String(
      config?.plan_name || user?.plan_name || user?.plan?.name || user?.plan_id || user?.plan || ""
    ).toLowerCase();

    if (rawModules?.includes?.("all") || (!configuredModules && /\b(pro|bundle|studio|full)\b/.test(planText))) {
      allowedModules = [...ALL_MODULES];
    } else if (!allowedModules.length && planText.includes("clone")) {
      allowedModules = ["clone"];
    } else if (!allowedModules.length && hasToken) {
      allowedModules = ["clone"];
    }

    allowedModules = [...new Set(allowedModules)];
    const planName = config?.plan_name || user?.plan_name || user?.plan?.name ||
      (allowedModules.length === ALL_MODULES.length ? "POD Pro Bundle" :
        allowedModules[0] === "redesign" ? "Redesign GPTs" :
          allowedModules[0] === "mockup" ? "Mockup GPTs" : "Clone GPTs");
    const email = user?.email || user?.username || user?.account?.email || "Tài khoản Podhub";
    return {allowedModules, planName, email};
  }

  function showUpgradeModal(moduleId, planName) {
    const root = document.querySelector("#pub-root");
    if (!root) return;
    root.querySelector(".pub-upsell-backdrop")?.remove();

    const moduleNames = {clone: "Clone", redesign: "Redesign", mockup: "Mockup"};
    const backdrop = document.createElement("div");
    backdrop.className = "pub-upsell-backdrop";
    const modal = document.createElement("div");
    modal.className = "pub-upsell-modal";

    const icon = make("pub-upsell-icon", "🔒");
    const title = document.createElement("h3");
    title.className = "pub-upsell-title";
    title.textContent = `Mở khóa ${moduleNames[moduleId] || moduleId}`;
    const description = document.createElement("p");
    description.className = "pub-upsell-desc";
    description.textContent = `Gói ${planName || "Clone"} chưa hỗ trợ module này. Nâng cấp POD Pro Bundle để sử dụng đầy đủ tính năng.`;

    const actions = document.createElement("div");
    actions.className = "pub-upsell-actions";
    const pricingButton = document.createElement("button");
    pricingButton.type = "button";
    pricingButton.className = "pub-btn-pricing";
    pricingButton.textContent = "Nâng cấp ngay";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "pub-btn-close-modal";
    closeButton.textContent = "Đóng";

    pricingButton.addEventListener("click", () => window.open(PRICING_URL, "_blank", "noopener,noreferrer"));
    closeButton.addEventListener("click", () => backdrop.remove());
    backdrop.addEventListener("click", event => {
      if (event.target === backdrop) backdrop.remove();
    });
    actions.append(pricingButton, closeButton);
    modal.append(icon, title, description, actions);
    backdrop.appendChild(modal);
    root.appendChild(backdrop);
  }

  async function syncLicenseUi() {
    if (licenseSyncing || typeof chrome === "undefined" || !chrome.storage?.local) return;
    licenseSyncing = true;
    try {
      const root = document.querySelector("#pub-root");
      if (!root) return;
      const saved = await chrome.storage.local.get(["pub_license_token", "pub_license_user", "pub_runtime_config"]);
      const token = saved.pub_license_token;
      const user = saved.pub_license_user || {};
      const config = saved.pub_runtime_config || {};
      const {allowedModules, planName, email} = getLicenseAccess(user, config, Boolean(token));

      const status = root.querySelector(".pub-account-status");
      const logoutButton = root.querySelector('[data-action="deactivate"]');
      root.classList.toggle("license-active", Boolean(token));
      status?.classList.toggle("active", Boolean(token));
      if (logoutButton) logoutButton.hidden = !token;
      if (status) {
        const nextStatus = token ? `${planName} · Active · ${email}` : "Chưa kích hoạt license";
        if (status.textContent !== nextStatus) status.textContent = nextStatus;
        if (!licenseStatusObserver) {
          licenseStatusObserver = new MutationObserver(() => syncLicenseUi().catch(() => {}));
          licenseStatusObserver.observe(status, {childList: true, characterData: true, subtree: true});
        }
      }

      root.querySelectorAll(".pub-tab").forEach(tab => {
        const moduleId = normalizeModuleId(tab.dataset.module || tab.dataset.tab || tab.textContent);
        if (!moduleId) return;
        const locked = Boolean(token) && !allowedModules.includes(moduleId);
        tab.classList.toggle("pub-tab-locked", locked);
        tab.dataset.lockedModule = locked ? moduleId : "";
        tab.dataset.lockedPlan = locked ? planName : "";
        let lockIcon = tab.querySelector(".pub-lock-icon");
        if (locked && !lockIcon) {
          lockIcon = document.createElement("span");
          lockIcon.className = "pub-lock-icon";
          lockIcon.textContent = "🔒";
          lockIcon.setAttribute("aria-hidden", "true");
          tab.appendChild(lockIcon);
        } else if (!locked) {
          lockIcon?.remove();
        }
        if (!tab.dataset.lockHandlerAttached) {
          tab.dataset.lockHandlerAttached = "1";
          tab.addEventListener("click", event => {
            if (!tab.classList.contains("pub-tab-locked")) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            showUpgradeModal(tab.dataset.lockedModule, tab.dataset.lockedPlan);
          }, true);
        }
      });
    } finally {
      licenseSyncing = false;
    }
  }

  function refreshMarketplaceJobs() {
    clearTimeout(marketplaceRefreshTimer);
    const refresh = () => {
      const root = document.querySelector("#pub-root");
      if (!root) return;
      const explicitButton = [...root.querySelectorAll("button")].find(button => {
        const action = String(button.dataset.action || "").toLowerCase();
        const label = `${button.textContent || ""} ${button.title || ""}`.toLowerCase();
        return /refresh|reload|sync/.test(action) || /làm mới|tải lại|đồng bộ/.test(label);
      });
      if (explicitButton && !explicitButton.disabled) {
        explicitButton.click();
        return;
      }
      const activeModuleTab = root.querySelector(".pub-tab.active:not(.pub-tab-locked)");
      activeModuleTab?.click();
      setTimeout(() => loadFallbackJobs().catch(() => {}), 250);
    };
    refresh();
    marketplaceRefreshTimer = setTimeout(refresh, 900);
  }

  function sendRuntimeMessage(message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, response => {
          if (chrome.runtime.lastError) {
            resolve({ok: false, error: chrome.runtime.lastError.message});
            return;
          }
          resolve(response || {ok: false, error: "BRIDGE_NO_RESPONSE"});
        });
      } catch (error) {
        resolve({ok: false, error: error.message});
      }
    });
  }

  const jobId = job => String(job?.id || job?.job_id || "");
  const jobTitle = job => String(
    job?.product_title || job?.title || job?.canonical_filename || job?.original_name ||
    job?.name || job?.asset?.name || jobId(job) || "Podhub job"
  );
  const jobImage = job => String(
    job?.thumbnail_url || job?.source_image_url || job?.image_url || job?.asset?.thumbnail_url ||
    job?.asset?.cdn_url || ""
  );

  function showFallbackError(container, message) {
    if (!container || container.querySelector("[data-job-index], .pub-job-card")) return;
    container.replaceChildren();
    const empty = make("pub-empty pub-fallback-error", `Không tải được job: ${message || "Lỗi kết nối Bridge"}`);
    container.appendChild(empty);
  }

  function renderFallbackJobs(container, moduleId, jobs) {
    if (!container || container.querySelector("[data-job-index], .pub-job-card:not(.pub-job-fallback)")) return;
    const pending = jobs.filter(job => !["done", "completed", "cancelled"].includes(String(job?.status || "").toLowerCase()));
    if (!pending.length) return;

    container.replaceChildren();
    for (const job of pending) {
      const id = jobId(job);
      const card = document.createElement("article");
      card.className = "pub-job-card pub-job-fallback";
      card.dataset.jobId = id;

      const runButton = document.createElement("button");
      runButton.type = "button";
      runButton.className = "pub-fallback-run";
      runButton.title = "Chạy job này";
      runButton.textContent = "▶";

      const thumb = make("pub-job-thumb");
      const imageUrl = jobImage(job);
      if (imageUrl) {
        const image = document.createElement("img");
        image.className = "pub-job-source";
        image.src = imageUrl;
        image.alt = jobTitle(job);
        thumb.appendChild(image);
      }

      const content = make("pub-job-content");
      const title = document.createElement("strong");
      title.className = "pub-job-title";
      title.title = jobTitle(job);
      title.textContent = jobTitle(job);
      const meta = make("pub-fallback-meta", `${String(job?.status || "queued")} · ${moduleId}`);
      content.append(title, meta);

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "pub-job-delete";
      deleteButton.title = "Xóa job";
      deleteButton.textContent = "×";

      runButton.addEventListener("click", async () => {
        runButton.disabled = true;
        const response = await sendRuntimeMessage({type: "PUB_START_JOB", moduleId, job});
        if (!response?.ok) {
          runButton.disabled = false;
          showFallbackError(container, response?.error || "JOB_START_FAILED");
        }
      });
      deleteButton.addEventListener("click", async () => {
        if (!window.confirm(`Xóa ${jobTitle(job)} khỏi hàng đợi?`)) return;
        deleteButton.disabled = true;
        const response = await sendRuntimeMessage({type: "PUB_DELETE_JOB", moduleId, jobId: id});
        if (response?.ok) card.remove();
        else {
          deleteButton.disabled = false;
          showFallbackError(container, response?.error || "JOB_DELETE_FAILED");
        }
      });

      card.append(runButton, thumb, content, deleteButton);
      container.appendChild(card);
    }
  }

  async function loadFallbackJobs() {
    const root = document.querySelector("#pub-root");
    const container = root?.querySelector(".pub-job-list");
    const activeTab = root?.querySelector(".pub-tab.active:not(.pub-tab-locked)");
    const moduleId = normalizeModuleId(activeTab?.dataset.module || activeTab?.dataset.tab || activeTab?.textContent);
    if (!root || !container || !moduleId) return;

    const requestId = ++fallbackJobsRequest;
    const response = await sendRuntimeMessage({type: "PUB_LIST_JOBS", moduleId});
    if (requestId !== fallbackJobsRequest) return;
    if (!response?.ok) {
      showFallbackError(container, response?.error);
      return;
    }
    const jobs = Array.isArray(response.data) ? response.data : [];
    setTimeout(() => {
      const currentTab = root.querySelector(".pub-tab.active:not(.pub-tab-locked)");
      const currentModule = normalizeModuleId(currentTab?.dataset.module || currentTab?.dataset.tab || currentTab?.textContent);
      if (currentModule === moduleId) renderFallbackJobs(container, moduleId, jobs);
    }, 180);
  }

  function startMarketplaceJobPolling() {
    if (marketplacePollingTimer) return;
    marketplacePollingTimer = setInterval(() => {
      const root = document.querySelector("#pub-root");
      if (!root || document.hidden) return;
      refreshMarketplaceJobs();
    }, 8000);
  }

  function startLicenseConfigPolling() {
    if (licenseConfigRefreshTimer || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    const refresh = async () => {
      if (document.hidden) return;
      const response = await sendRuntimeMessage({type: "PUB_REFRESH_CONFIG"});
      if (response?.ok) await syncLicenseUi();
    };
    refresh().catch(() => {});
    licenseConfigRefreshTimer = setInterval(() => refresh().catch(() => {}), 30000);
  }

  function revealDashboard() {
    const root = document.querySelector("#pub-root");
    if (!root) return false;
    root.classList.add("pub-visible");
    document.querySelector("#pub-launcher")?.classList.add("active");
    syncLicenseUi().catch(() => {});
    setTimeout(() => loadFallbackJobs().catch(() => {}), 200);
    return true;
  }

  async function consumeDashboardRequest() {
    if (dashboardRequestChecking || !document.querySelector("#pub-root")) return;
    dashboardRequestChecking = true;
    try {
      const saved = await chrome.storage.local.get(["pub_open_dashboard_requested"]);
      if (!saved.pub_open_dashboard_requested) return;
      await chrome.storage.local.remove(["pub_open_dashboard_requested"]);
      revealDashboard();
    } finally {
      dashboardRequestChecking = false;
    }
  }

  function applyUiFix() {
    const root = document.querySelector("#pub-root");
    if (!root) return;

    const activateButton = root.querySelector('[data-action="activate"]');
    if (activateButton) {
      activateButton.textContent = "Kích hoạt";
      activateButton.title = "Kích hoạt license Podhub";
    }

    const logoutButton = root.querySelector('[data-action="deactivate"]');
    if (logoutButton) {
      logoutButton.textContent = "Đăng xuất";
      logoutButton.classList.add("pub-btn", "secondary", "pub-btn-logout");
      logoutButton.title = "Đăng xuất khỏi tài khoản Podhub";
    }

    root.querySelectorAll('.pub-field-row [data-action="save-settings"]').forEach(button => {
      if (!button.closest(".pub-config-panel")) button.textContent = "Lưu";
    });

    const redesignReady = arrangeRedesign(root.querySelector('[data-config-panel="redesign"]'));
    const mockupReady = arrangeMockup(root.querySelector('[data-config-panel="mockup"]'));
    syncLicenseUi().catch(() => {});
    startMarketplaceJobPolling();
    startLicenseConfigPolling();
    consumeDashboardRequest().catch(() => {});
    if (!root.dataset.fallbackJobsAttached) {
      root.dataset.fallbackJobsAttached = "1";
      root.addEventListener("click", event => {
        if (event.target.closest(".pub-tab")) setTimeout(() => loadFallbackJobs().catch(() => {}), 300);
      });
      setTimeout(() => loadFallbackJobs().catch(() => {}), 500);
    }
    return redesignReady && mockupReady;
  }

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.pub_license_token || changes.pub_license_user || changes.pub_runtime_config) {
        syncLicenseUi().catch(() => {});
      }
      if (changes.pub_marketplace_jobs_revision) refreshMarketplaceJobs();
    });
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "PUB_MARKETPLACE_JOBS_UPDATED") refreshMarketplaceJobs();
    });
  }

  let bootstrapAttempts = 0;
  const bootstrapUiFix = () => {
    if (document.querySelector("#pub-root")) {
      applyUiFix();
      return;
    }
    bootstrapAttempts += 1;
    if (bootstrapAttempts < 20) setTimeout(bootstrapUiFix, 250);
  };
  bootstrapUiFix();
})();
