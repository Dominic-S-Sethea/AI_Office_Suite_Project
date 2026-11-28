import { useEffect, useRef, type FormEvent } from "react";
import { trapDialogTabKey } from "../lib/apiClient.ts";

interface NewDocumentModalProps {
  title: string;
  language: "en" | "km" | "bilingual";
  size: "A4" | "Letter";
  orientation: "portrait" | "landscape";
  isCreating: boolean;
  errorMessage: string | null;
  onTitleChange: (val: string) => void;
  onLanguageChange: (val: "en" | "km" | "bilingual") => void;
  onSizeChange: (val: "A4" | "Letter") => void;
  onOrientationChange: (val: "portrait" | "landscape") => void;
  onSubmit: (e: FormEvent) => Promise<void>;
  onClose: () => void;
}

export function NewDocumentModal({
  title,
  language,
  size,
  orientation,
  isCreating,
  errorMessage,
  onTitleChange,
  onLanguageChange,
  onSizeChange,
  onOrientationChange,
  onSubmit,
  onClose,
}: NewDocumentModalProps) {
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleInputRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      trapDialogTabKey(dialogRef.current, e);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (
        previouslyFocused &&
        document.contains(previouslyFocused) &&
        previouslyFocused.tabIndex >= 0 &&
        previouslyFocused.offsetParent !== null &&
        !(previouslyFocused as HTMLButtonElement).disabled
      ) {
        previouslyFocused.focus();
      } else {
        document.querySelector<HTMLElement>(".fixed-header-btn, .topbar-role-pill, main button")?.focus();
      }
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-doc-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form ref={dialogRef} className="modal-card" onSubmit={(e) => void onSubmit(e)}>
        <h2 id="new-doc-modal-title" className="modal-title">
          Create New Document
        </h2>
        {errorMessage && (
          <div className="banner-error" role="alert">
            {errorMessage}
          </div>
        )}
        <label>
          Title
          <input
            ref={titleInputRef}
            type="text"
            required
            maxLength={200}
            className="input-field"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="e.g. របាយការណ៍ហិរញ្ញវត្ថុ Q4 / Q4 Finance Brief"
          />
        </label>
        <div className="modal-grid-3">
          <label>
            Language
            <select
              className="input-field"
              value={language}
              onChange={(e) => onLanguageChange(e.target.value as "en" | "km" | "bilingual")}
            >
              <option value="bilingual">Bilingual</option>
              <option value="en">English</option>
              <option value="km">ខ្មែរ</option>
            </select>
          </label>
          <label>
            Page Size
            <select
              className="input-field"
              value={size}
              onChange={(e) => onSizeChange(e.target.value as "A4" | "Letter")}
            >
              <option value="A4">A4</option>
              <option value="Letter">Letter</option>
            </select>
          </label>
          <label>
            Orientation
            <select
              className="input-field"
              value={orientation}
              onChange={(e) => onOrientationChange(e.target.value as "portrait" | "landscape")}
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={isCreating || !title.trim()}>
            {isCreating ? "Creating..." : "Create Document"}
          </button>
        </div>
      </form>
    </div>
  );
}
