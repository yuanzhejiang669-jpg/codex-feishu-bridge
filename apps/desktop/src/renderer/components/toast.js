import { escapeHtml } from "../ipc.js";

export function showToast(message, tone = "info") {
  const region = document.getElementById("toast-region");
  if (!region) return;
  const normalizedTone = ["info", "ok", "warn", "error"].includes(tone) ? tone : "info";
  const toast = document.createElement("div");
  toast.className = `toast ${normalizedTone}`;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.innerHTML = `
    <span>${escapeHtml(message)}</span>
    <button class="toast-close" type="button" aria-label="关闭通知">✕</button>
  `;
  const remove = () => {
    toast.remove();
  };
  toast.querySelector(".toast-close")?.addEventListener("click", remove);
  region.appendChild(toast);
  if (normalizedTone !== "error") {
    setTimeout(remove, 4000);
  }
}
