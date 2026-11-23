import { escapeHtml, formatIpcError } from "../ipc.js";
import { showToast } from "./toast.js";

let activeModal = null;
let previousFocus = null;

export function isConfirmModalOpen() {
  return Boolean(activeModal);
}

export function closeConfirmModal() {
  const backdrop = document.getElementById("confirm-modal");
  if (backdrop) {
    backdrop.classList.remove("open");
    backdrop.innerHTML = "";
  }
  activeModal = null;
  if (previousFocus && typeof previousFocus.focus === "function") {
    try {
      previousFocus.focus();
    } catch {
      // ignore focus restore failure
    }
  }
  previousFocus = null;
}

export function openConfirmModal(options = {}) {
  const backdrop = document.getElementById("confirm-modal");
  if (!backdrop) return;
  previousFocus = document.activeElement;
  activeModal = { ...options, busy: false };

  const details = Array.isArray(options.details) ? options.details : [];
  const checkboxes = Array.isArray(options.checkboxes) ? options.checkboxes : [];
  const confirmId = options.confirmButtonId ? ` id="${escapeHtml(options.confirmButtonId)}"` : "";
  const dialogId = options.dialogId ? ` id="${escapeHtml(options.dialogId)}"` : "";
  const confirmClass = options.danger ? "btn btn-danger-solid" : "btn btn-primary";
  const disabledAttr = options.disabledReason ? " disabled" : "";

  backdrop.innerHTML = `
    <div class="modal modal-sm"${dialogId}>
      <div class="modal-head">
        <h2 class="card-title" id="confirm-title">${escapeHtml(options.title || "确认操作")}</h2>
        <button class="btn btn-ghost btn-sm" type="button" data-confirm-close aria-label="关闭弹窗">✕</button>
      </div>
      <div class="modal-body">
        ${options.description ? `<p class="alert-text">${escapeHtml(options.description)}</p>` : ""}
        ${options.warning ? `<div class="alert-row danger"><div class="alert-text">${escapeHtml(options.warning)}</div></div>` : ""}
        ${options.disabledReason ? `<div class="alert-row"><div class="alert-text">${escapeHtml(options.disabledReason)}</div></div>` : ""}
        ${details.length ? `
          <dl class="kv-grid">
            ${details.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd class="mono">${escapeHtml(value)}</dd>`).join("")}
          </dl>
        ` : ""}
        ${checkboxes.length ? `
          <div class="item-list">
            ${checkboxes.map((box) => `
              <label class="checkbox-row">
                <input type="checkbox" data-confirm-box="${escapeHtml(box.name)}" ${box.checked ? "checked" : ""} ${box.disabled ? "disabled" : ""} />
                <span>
                  <strong>${escapeHtml(box.label)}</strong>
                  ${box.hint ? `<div class="field-hint">${escapeHtml(box.hint)}</div>` : ""}
                </span>
              </label>
            `).join("")}
          </div>
        ` : ""}
      </div>
      <div class="modal-foot">
        <button class="btn" type="button" data-confirm-close>${escapeHtml(options.cancelLabel || "取消")}</button>
        <button class="${confirmClass}" type="button" data-confirm-submit${confirmId}${disabledAttr}>
          ${escapeHtml(options.confirmLabel || "确认")}
        </button>
      </div>
    </div>
  `;

  backdrop.classList.add("open");

  const closeButtons = backdrop.querySelectorAll("[data-confirm-close]");
  closeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (!activeModal?.busy) closeConfirmModal();
    });
  });

  backdrop.onclick = (event) => {
    if (event.target === backdrop && !activeModal?.busy) {
      closeConfirmModal();
    }
  };

  const submitBtn = backdrop.querySelector("[data-confirm-submit]");
  submitBtn?.addEventListener("click", async () => {
    if (!activeModal || activeModal.busy || options.disabledReason) return;
    const values = {};
    backdrop.querySelectorAll("[data-confirm-box]").forEach((input) => {
      values[input.dataset.confirmBox] = input.checked;
    });
    activeModal.busy = true;
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "处理中...";
    try {
      await options.onConfirm?.(values);
      closeConfirmModal();
    } catch (error) {
      showToast(formatIpcError(error), "error");
      if (activeModal) {
        activeModal.busy = false;
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      }
    }
  });

  const focusTarget = backdrop.querySelector("[data-confirm-close]");
  focusTarget?.focus();
}
