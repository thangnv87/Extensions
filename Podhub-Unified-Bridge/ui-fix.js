(() => {
  "use strict";

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
    if (redesignReady && mockupReady) observer.disconnect();
  }

  const observer = new MutationObserver(applyUiFix);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  applyUiFix();
})();
