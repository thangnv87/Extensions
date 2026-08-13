(() => {
  "use strict";

  function createElement(className, text) {
    const element = document.createElement("div");
    element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function applyUiFix() {
    const root = document.querySelector("#pub-root");
    if (!root) return;

    const logoutButton = root.querySelector('[data-action="deactivate"]');
    if (logoutButton && logoutButton.dataset.uiFixApplied !== "1") {
      logoutButton.textContent = "Logout";
      logoutButton.classList.add("pub-btn", "secondary", "pub-btn-logout");
      logoutButton.title = "Đăng xuất khỏi tài khoản Podhub";
      logoutButton.dataset.uiFixApplied = "1";
    }

    const panel = root.querySelector('[data-config-panel="mockup"]');
    if (!panel || panel.dataset.uiFixApplied === "1") return;

    const flow = panel.querySelector(".pub-flow-text");
    const quickSettings = panel.querySelector(".pub-mockup-quick-row");
    const productGrid = panel.querySelector("#pub-product-grid");
    const marketGrid = panel.querySelector("#pub-mockup-market-grid");
    const customProductInput = panel.querySelector("#pub-mockup-custom-product");
    const addProductRow = customProductInput?.closest(".pub-add-row");

    if (!flow || !quickSettings || !productGrid || !marketGrid || !addProductRow) {
      return;
    }

    const saveButton = quickSettings.querySelector('[data-action="save-settings"]');
    if (saveButton) saveButton.hidden = true;

    const legacyProductLabel = productGrid.previousElementSibling;
    const legacyMarketLabel = marketGrid.previousElementSibling;
    if (legacyProductLabel?.tagName === "LABEL") legacyProductLabel.remove();
    if (legacyMarketLabel?.tagName === "LABEL") legacyMarketLabel.remove();

    for (const child of [...panel.children]) {
      if (
        child.tagName === "LABEL" &&
        /Cấu hình sản phẩm|Cấu hình sàn listing/i.test(child.textContent || "")
      ) {
        child.remove();
      }
    }

    const productTitle = createElement("pub-section-title", "Sản phẩm cần tạo Mockup");
    const productNote = createElement(
      "pub-section-note",
      "(Chọn ít nhất 1 sản phẩm để GPT biết cần vẽ lên phôi nào)"
    );
    const divider = createElement("pub-divider");
    const listingTitle = createElement("pub-section-title", "Tạo Listing cho sàn");

    flow.after(
      productTitle,
      productNote,
      productGrid,
      addProductRow,
      quickSettings,
      divider,
      listingTitle,
      marketGrid
    );

    panel.dataset.uiFixApplied = "1";
    observer.disconnect();
  }

  const observer = new MutationObserver(applyUiFix);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  applyUiFix();
})();
