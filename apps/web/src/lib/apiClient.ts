export const MAX_DOCX_UPLOAD_BYTES = 10 * 1024 * 1024; // Aligned with server 10 MB DOCX limit (H23)

export async function safeReadJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return { error: `Request failed with HTTP ${res.status}` };
  }
}

export function formatApiErrorMessage(
  res: Response,
  data: Record<string, unknown>,
  fallback: string,
): string {
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after") ?? String(data.retryAfterSeconds ?? "");
    const parsedSec = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(parsedSec) && parsedSec > 0) {
      return `Rate limit exceeded — please wait ${parsedSec}s before retrying.`;
    }
    return "Rate limit exceeded — please wait a moment before retrying.";
  }
  if (res.status === 503 && data.code === "SERVICE_BUSY") {
    const retryAfter = res.headers.get("retry-after") ?? String(data.retryAfterSeconds ?? "2");
    return `Service is currently at capacity — please retry in ${retryAfter}s.`;
  }
  return String(data.error ?? fallback);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export function trapDialogTabKey(container: HTMLElement | null, event: KeyboardEvent): void {
  if (event.key !== "Tab" || !container) return;
  const focusables = getFocusableElements(container);
  if (focusables.length === 0) return;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  if (event.shiftKey) {
    if (document.activeElement === first || !container.contains(document.activeElement)) {
      event.preventDefault();
      last.focus();
    }
  } else if (document.activeElement === last || !container.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  }
}
