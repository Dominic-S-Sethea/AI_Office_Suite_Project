import { memo, useEffect, type CSSProperties } from "react";

export type FixedHeaderId =
  | "files"
  | "layout"
  | "data"
  | "workflows"
  | "versions"
  | "admin";

export interface NavSubHeaderItem {
  id: string;
  label: string;
  badge?: string;
  disabled?: boolean;
  active?: boolean;
  title?: string;
  onSelect: () => void;
}

export interface NavFixedHeaderGroup {
  id: FixedHeaderId;
  label: string;
  shortTag: string;
  subHeaders: NavSubHeaderItem[];
}

interface LeftNavRailProps {
  groups: NavFixedHeaderGroup[];
  openHeaderId: FixedHeaderId | null;
  onToggleHeader: (id: FixedHeaderId | null) => void;
}

function SectionIcon({ id }: { id: FixedHeaderId }) {
  switch (id) {
    case "files":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="13" y2="17" />
        </svg>
      );
    case "layout":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="9" y1="21" x2="9" y2="9" />
        </svg>
      );
    case "data":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      );
    case "workflows":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="6" cy="6" r="3" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="12" cy="18" r="3" />
          <path d="M6 9v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V9" />
          <line x1="12" y1="14" x2="12" y2="15" />
        </svg>
      );
    case "versions":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <polyline points="12 7 12 12 15.5 14" />
        </svg>
      );
    case "admin":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <polyline points="9 12 11 14 15 10" />
        </svg>
      );
  }
}

function LeftNavRailInner({ groups, openHeaderId, onToggleHeader }: LeftNavRailProps) {
  useEffect(() => {
    if (!openHeaderId) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Let active modal dialogs / drawers handle Escape first so focus restoration isn't corrupted
        if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) {
          return;
        }
        e.preventDefault();
        onToggleHeader(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [openHeaderId, onToggleHeader]);

  return (
    <nav className="left-fixed-rail" aria-label="Workspace Sections">
      <div className="left-rail-heading">Sections</div>
      <ul className="fixed-header-list" role="menubar" aria-orientation="vertical">
        {groups.map((group) => {
          const isOpen = openHeaderId === group.id;
          const menuId = `subheaders-${group.id}`;
          const hasActiveSub = group.subHeaders.some((s) => s.active);

          return (
            <li
              key={group.id}
              className={`fixed-header-item ${isOpen ? "is-open" : ""}`}
              role="none"
            >
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                aria-controls={menuId}
                className={`fixed-header-btn ${isOpen ? "is-open" : ""} ${hasActiveSub ? "has-active" : ""}`}
                onClick={() => onToggleHeader(isOpen ? null : group.id)}
              >
                <span className="fixed-header-accent" aria-hidden="true" />
                <span className="fixed-header-icon" aria-hidden="true">
                  <SectionIcon id={group.id} />
                </span>
                <span className="fixed-header-label">{group.label}</span>
                <svg
                  className={`fixed-header-chevron ${isOpen ? "is-open" : ""}`}
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {/* Smooth vertical downward accordion dropdown (stays mounted for fluid open & close transitions) */}
              <div
                id={menuId}
                role="menu"
                aria-label={`${group.label} sub-headers`}
                aria-hidden={!isOpen}
                className={`vertical-dropdown-wrap ${isOpen ? "is-open" : ""}`}
              >
                <div className="vertical-dropdown-inner">
                  <div className="vertical-subheaders-list">
                    {group.subHeaders.map((sub, idx) => (
                      <div
                        key={sub.id}
                        className="vertical-subheader-row"
                        style={{ "--item-index": idx } as CSSProperties}
                        role="none"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          tabIndex={isOpen ? 0 : -1}
                          disabled={sub.disabled}
                          title={sub.title}
                          className={`vertical-subheader-btn ${sub.active ? "is-active" : ""}`}
                          onClick={() => sub.onSelect()}
                        >
                          <span className="vertical-subheader-dot" aria-hidden="true" />
                          <span className="vertical-subheader-label">{sub.label}</span>
                          {sub.badge && <span className="subheader-badge">{sub.badge}</span>}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export const LeftNavRail = memo(LeftNavRailInner);

