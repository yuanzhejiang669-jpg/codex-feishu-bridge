import { escapeHtml } from "../ipc.js";

const MAX_VISIBLE_TOASTS = 3;

export function showToast(message, tone = "info") {
  const region = document.getElementById("toast-region");
  if (!region) return;
  const normalizedTone = ["info", "ok", "warn", "error"].includes(tone) ? tone : "info";
  const rawText = String(message || "").trim();
  if (!rawText) return;
  const displayText = rawText.length > 260 ? `${rawText.slice(0, 257)}...` : rawText;
  const dedupeKey = `${normalizedTone}::${displayText}`;

  const existing = [...region.querySelectorAll(".toast")].find((el) => el.dataset.toastKey === dedupeKey);
  if (existing) {
    existing.remove();
  }
  while (region.children.length >= MAX_VISIBLE_TOASTS) {
    region.firstElementChild?.remove();
  }

  const toast = document.createElement("div");
  toast.className = `toast ${normalizedTone}`;
  toast.dataset.toastKey = dedupeKey;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.innerHTML = `
    <span class="toast-message">${escapeHtml(displayText)}</span>
    <button class="toast-close" type="button" aria-label="关闭通知">✕</button>
  `;

  let timer = null;
  const durationMs = normalizedTone === "error" ? 8000 : 4000;
  const remove = () => {
    if (timer) clearTimeout(timer);
    toast.remove();
  };
  const armTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(remove, durationMs);
  };

  toast.querySelector(".toast-close")?.addEventListener("click", remove);
  toast.addEventListener("mouseenter", () => { if (timer) clearTimeout(timer); });
  toast.addEventListener("mouseleave", armTimer);
  region.appendChild(toast);
  armTimer();
}
