import { memo, useEffect, useRef } from "react";

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

function LeftNavRailInner({ groups, openHeaderId, onToggleHeader }: LeftNavRailProps) {
  const railRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!openHeaderId) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onToggleHeader(null);
      }
    }

    function handlePointerDown(e: MouseEvent) {
      if (railRef.current && !railRef.current.contains(e.target as Node)) {
        onToggleHeader(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [openHeaderId, onToggleHeader]);

  return (
    <nav ref={railRef} className="left-fixed-rail" aria-label="Workspace Sections">
      <div className="left-rail-heading">Sections</div>
      <ul className="fixed-header-list" role="menubar" aria-orientation="vertical">
        {groups.map((group) => {
          const isOpen = openHeaderId === group.id;
          const menuId = `subheaders-${group.id}`;
          const hasActiveSub = group.subHeaders.some((s) => s.active);

          return (
            <li key={group.id} className="fixed-header-item" role="none">
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                aria-controls={menuId}
                className={`fixed-header-btn ${isOpen ? "is-open" : ""} ${hasActiveSub ? "has-active" : ""}`}
                onClick={() => onToggleHeader(isOpen ? null : group.id)}
              >
                <span className="fixed-header-tag" aria-hidden="true">
                  {group.shortTag}
                </span>
                <span className="fixed-header-label">{group.label}</span>
                <span className="fixed-header-chevron" aria-hidden="true">
                  {isOpen ? "◂" : "▸"}
                </span>
              </button>

              {isOpen && (
                <div
                  id={menuId}
                  role="menu"
                  aria-label={`${group.label} sub-headers`}
                  className="horizontal-subheader-flyout"
                >
                  <span className="flyout-group-title">{group.label}</span>
                  <div className="flyout-subheaders-row">
                    {group.subHeaders.map((sub) => (
                      <button
                        key={sub.id}
                        type="button"
                        role="menuitem"
                        disabled={sub.disabled}
                        title={sub.title}
                        className={`subheader-chip ${sub.active ? "is-active" : ""}`}
                        onClick={() => {
                          sub.onSelect();
                          onToggleHeader(null);
                        }}
                      >
                        <span>{sub.label}</span>
                        {sub.badge && <span className="subheader-badge">{sub.badge}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export const LeftNavRail = memo(LeftNavRailInner);
