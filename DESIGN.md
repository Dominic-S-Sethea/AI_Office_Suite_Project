---
name: AI Office Suite
description: Bilingual English and Khmer executive document workspace built around Sovereign Cobalt clarity, dark archival chrome, and accountable governance cues.
colors:
  sovereign-cobalt: "#1d4ed8"
  sovereign-cobalt-hover: "#1e40af"
  cobalt-wash: "#eff6ff"
  cobalt-rule: "#bfdbfe"
  ledger-ink-navy: "#0f172a"
  chrome-slate: "#1e293b"
  archival-slate-mist: "#f1f5f9"
  paper-white: "#ffffff"
  paper-subtle: "#f8fafc"
  ink-secondary: "#334155"
  slate-muted: "#475569"
  chrome-ink: "#cbd5e1"
  chrome-ink-bright: "#f8fafc"
  chrome-ink-muted: "#94a3b8"
  hairline-border: "#cbd5e1"
  hairline-subtle: "#e2e8f0"
  audit-amber: "#92400e"
  audit-amber-bg: "#fffbeb"
  guardrail-crimson: "#b91c1c"
  guardrail-crimson-bg: "#fef2f2"
  verified-emerald: "#065f46"
  verified-emerald-bg: "#ecfdf5"
typography:
  headline-h1:
    fontFamily: "Kantumruy Pro, Noto Sans Khmer, sans-serif"
    fontSize: "21.75px"
    fontWeight: 700
    lineHeight: 1.65
    letterSpacing: "0em"
  headline-h2:
    fontFamily: "Kantumruy Pro, Noto Sans Khmer, sans-serif"
    fontSize: "18.125px"
    fontWeight: 700
    lineHeight: 1.65
    letterSpacing: "0em"
  title:
    fontFamily: "Kantumruy Pro, Noto Sans Khmer, Khmer OS Battambang, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.25
  body-document:
    fontFamily: "Kantumruy Pro, Noto Sans Khmer, Khmer OS Battambang, sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: 1.8
    letterSpacing: "0em"
  body-ui:
    fontFamily: "Kantumruy Pro, Noto Sans Khmer, Khmer OS Battambang, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  label-caption:
    fontFamily: "Kantumruy Pro, Noto Sans Khmer, Khmer OS Battambang, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.2
  label-rail-heading:
    fontFamily: "Kantumruy Pro, Noto Sans Khmer, Khmer OS Battambang, sans-serif"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.1em"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "24px"
  sheet-y: "48px"
  sheet-x: "56px"
components:
  button-primary:
    backgroundColor: "{colors.sovereign-cobalt}"
    textColor: "{colors.paper-white}"
    typography: "body-ui"
    rounded: "{rounded.sm}"
    padding: "5px 11px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.sovereign-cobalt-hover}"
    textColor: "{colors.paper-white}"
  button-secondary:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.ledger-ink-navy}"
    typography: "body-ui"
    rounded: "{rounded.sm}"
    padding: "5px 11px"
    height: "32px"
  button-danger:
    backgroundColor: "{colors.guardrail-crimson}"
    textColor: "{colors.paper-white}"
    typography: "body-ui"
    rounded: "{rounded.sm}"
    padding: "5px 11px"
    height: "32px"
  input-field:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.ledger-ink-navy}"
    rounded: "{rounded.sm}"
    padding: "7px 10px"
  card-preview:
    backgroundColor: "{colors.paper-subtle}"
    textColor: "{colors.ledger-ink-navy}"
    rounded: "{rounded.md}"
    padding: "10px"
  badge-ok:
    backgroundColor: "{colors.verified-emerald-bg}"
    textColor: "{colors.verified-emerald}"
    rounded: "{rounded.pill}"
    padding: "3px 9px"
  badge-warn:
    backgroundColor: "{colors.audit-amber-bg}"
    textColor: "{colors.audit-amber}"
    rounded: "{rounded.pill}"
    padding: "3px 9px"
  studio-tab-active:
    backgroundColor: "{colors.sovereign-cobalt}"
    textColor: "{colors.paper-white}"
    typography: "body-ui"
    rounded: "{rounded.sm}"
    padding: "5px 11px"
    height: "32px"
---

# Design System: AI Office Suite

## Overview

**Creative North Star: "The Audited Ledger Desk"**

AI Office Suite pairs dark archival perimeter chrome with crisp white editorial paper so bilingual English and ខ្មែរ documents command the central desk. Interactive controls stay refined and restrained, ensuring permissions, diffs, mock speech status, and planned boundaries remain immediately scannable defined across `apps/web/src/styles.css` and `apps/web/src/App.tsx`.

It rejects glossy consumer gradients across content cards, decorative glassmorphism, neon dark-mode accents, one-sided border bars, and Latin-only fonts that clip Khmer coeng subscripts.

**Key Characteristics:**
- Dark slate perimeter navigation framing an archival mist stage and crisp white manuscripts
- Harmonized bilingual English and ខ្មែរ type scale using `Kantumruy Pro` and `Noto Sans Khmer`
- Hairline-bordered controls at rest with structural shadows reserved for sheets, docks, and overlays
- Honest, color-coded provenance cues separating live APIs, read-only guards, mock speech, and planned studios

## Colors

Tokens defined in `apps/web/src/styles.css` separate quiet editorial surfaces from dark navigation chrome and high-contrast semantic alerts.

### Primary
- **Sovereign Cobalt** (#1d4ed8): Active studio tabs, primary save/apply buttons, active formatting controls, focus outlines, and the text caret.
- **Sovereign Cobalt Hover** (#1e40af): Hover and pressed state for primary buttons.
- **Cobalt Wash** (#eff6ff) with **Cobalt Rule** (#bfdbfe): Soft highlight for active document rows, AI proposal previews, diff summaries, and text selections.

### Secondary
- **Audit Amber** (#92400e) on **Audit Amber Bg** (#fffbeb): Mock Speech disclosures (`isMock: true`), live export badges, revision conflict banners, and read-only role highlights.
- **Guardrail Crimson** (#b91c1c) on **Guardrail Crimson Bg** (#fef2f2): Two-step restore confirmations, alert banners, and denied audit events.
- **Verified Emerald** (#065f46) on **Verified Emerald Bg** (#ecfdf5): Current revisions, approved audit outcomes, voice badges, and `Live API` / `Live Controls` pills.

### Neutral
- **Ledger Ink Navy** (#0f172a) and **Chrome Slate** (#1e293b): Dark topbar/rail surfaces (`#0f172a`, `#1e293b`) and primary body ink on paper.
- **Archival Slate Mist** (#f1f5f9), **Paper White** (#ffffff), and **Paper Subtle** (#f8fafc): Workspace canvas (`#f1f5f9`), A4/Letter sheets and default controls (`#ffffff`), and recessed cards (`#f8fafc`).
- **Ink Secondary** (#334155) and **Slate Muted** (#475569): Excerpts, timestamps, footers, and disabled ink meeting WCAG AA (`>= 4.5:1`).
- **Chrome Ink** (#cbd5e1), **Chrome Ink Bright** (#f8fafc), and **Chrome Ink Muted** (#94a3b8): High-contrast dark chrome labels and uppercase rail headings.
- **Hairline Border** (#cbd5e1) and **Hairline Subtle** (#e2e8f0): Standard 1px perimeter strokes for cards, tables, and form fields.

### Named Rules
**The One-Accent Authority Rule.** Sovereign Cobalt (#1d4ed8) is reserved for active selection, primary commitment actions, and focus rings; inactive navigation items and neutral badges never receive saturated blue fills.
**The Honest Semantic Status Rule.** Amber signals mock disclosures, conflicts, and export progress; Crimson guards destructive actions and errors; Emerald marks verified live state.

## Typography

**Display Font:** `Kantumruy Pro` (with `Noto Sans Khmer` fallback; weights 400/500/600/700 in `apps/web/src/main.tsx`)
**Body Font:** `Kantumruy Pro` (with `Noto Sans Khmer` and `Khmer OS Battambang` fallbacks)
**Label/Mono Font:** `Kantumruy Pro` with `tabular-nums` on ledger cells, KPIs, and statusbar counts; monospace solely for block IDs and CSV/JSON API previews.

**Character:** Harmonized bilingual sans typography aligning Latin x-height with tall Khmer vowels and stacked coeng subscripts to prevent baseline jitter.

### Hierarchy
- **Headline H1** (700, 21.75px, line-height 1.65): Top report headings with balanced wrap and `0em` tracking.
- **Headline H2** (700, 18.125px, line-height 1.65): Section headings (`1.1em` top / `0.4em` bottom spacing).
- **Title** (700, 15px, line-height 1.25): Topbar brand mark and drawer/modal headings (`16px`).
- **Body Document** (400, 14.5px, line-height 1.8): Editorial EN/ខ្មែរ prose with normal word breaking.
- **Body UI** (500, 12px, line-height 1.5): Buttons, selectors, tabs, and accordion items.
- **Label Caption** (400, 11px, line-height 1.2): Badges, metadata, and statusbar telemetry using `tabular-nums`.
- **Label Rail Heading** (700, 10px uppercase, tracking 0.1em): Compact section heading on the dark left rail.

### Named Rules
**The Khmer Clearance Rule.** Prose runs at `1.8` line-height and headings at `1.65` with `0` letter-spacing so stacked Khmer subscripts never clip.
**The Tabular Ledger Rule.** Numeric KPIs, revision counters, and table cells enforce `tabular-nums` alignment.

## Layout

Desktop uses a 3-zone grid: fixed dark navigation rail (`260px`), collapsible documents sidebar (`236px`), and fluid workspace (`1fr`) housing sub-panels, an editorial sheet (`794px` portrait / `1056px` landscape), and a docked AI & Voice bar.

- **Compact Workstation (`<= 1180px`):** Rail compacts to `226px` and explorer to `190px` with tighter button/icon padding so long labels never truncate; expanded AI dock caps at `38vh`.
- **Drawer Collapse (`<= 960px`):** Single vertical stack; rail hides behind the topbar `Sections` toggle and documents drawer auto-collapses.
- **Mobile Reading Flow (`<= 640px`):** Two-row topbar (controls above scrollable studio tabs), full vertical page scroll placing manuscripts immediately above the fold, single-row scrollable formatting toolbar, and `>= 44px` touch targets.

## Elevation & Depth

Hierarchy relies on 1px hairline borders across stepped neutrals; soft structural drop shadows appear only on paper sheets, entering sub-panels, docked shelves, and modal overlays. Zero-offset halos and hard block shadows are excluded.

### Shadow Vocabulary
- **Subtle Panel** (`box-shadow: 0 4px 14px rgba(15, 23, 42, 0.06)`): Contextual sub-panels above the stage.
- **Sheet Elevation** (`box-shadow: 0 6px 24px rgba(15, 23, 42, 0.08)`): A4/Letter sheets and auth cards.
- **Modal Dialog** (`box-shadow: 0 12px 32px rgba(15, 23, 42, 0.16)`): Dialogs above darkened backdrop (`rgba(15, 23, 42, 0.45)`).
- **Docked Shelf** (`box-shadow: 0 -4px 18px rgba(15, 23, 42, 0.06)`): Upward boundary above bottom AI dock.
- **Active Rail Glow** (`box-shadow: 0 4px 14px rgba(29, 78, 216, 0.3)`): Active section button inside dark left rail.

### Named Rules
**The Structural Shadow Rule.** Flat cards remain border-defined at rest; shadows reserve tactile depth strictly for manuscripts, docks, and modals.

## Shapes

Geometry stays restrained: `4px` on diff boxes, `6px` on buttons, inputs, and notices, `8px` on cards and toolbars, `10px` on sub-panels, modals, and rail groups, crisp rectangular paper sheets, and `999px` full pills for compact badges.

**The Full-Perimeter Border Rule.** Notices, diffs, and two-step confirmations use complete 1px perimeter borders rather than one-sided stripe accents.

## Components

Interactive controls expose default, hover, `:focus-visible` (`2px solid` Sovereign Cobalt, `2px` offset), active, and disabled states (`0.55` opacity plus explanatory RBAC tooltips and `aria-describedby` links).

### Buttons
- **Shape:** Subtle `6px` corners, minimum `32px` desktop height (`44px` under `<= 640px` or `pointer: coarse`).
- **Primary:** Sovereign Cobalt (`#1d4ed8`) fill, Paper White ink, `5px 11px` padding, hovering to `#1e40af`.
- **Secondary & Danger:** Paper White secondary (`#ffffff`, `1px` border `#cbd5e1`), and Guardrail Crimson (`#b91c1c`) reserved for two-step `Confirm Restore`.

### Chips & Status Badges
- **Style:** Full pill (`999px`), `11px` weight-600 (`3px 9px` padding) across semantic tints (`Verified Emerald`, `Audit Amber`, `Guardrail Crimson`, neutral `Paper Subtle`).
- **State:** Read-only role pills carry Audit Amber borders in dark topbar chrome for immediate visibility.

### Cards / Containers
- **Style:** `8px` corners (`10px` on workspace sub-panels and modals), `Paper Subtle` (`#f8fafc`) fill (`#eff6ff` on active diff summaries), `1px` hairline border, and `10px–14px` internal padding.

### Inputs / Fields
- **Style:** `Paper White` fill, `1px` border (`#cbd5e1`), `6px` radius, `text` cursor preserved cleanly on textareas; disabled state uses `#f1f5f9` fill with `#475569` ink.

### Navigation
- **Top Studio Bar & Left Rail:** Ledger Ink Navy (`#0f172a`) bar contrasting solid active `Document Studio` against dashed `Planned` studio tabs (`#475569` border); dark accordion rail uses `300ms cubic-bezier(0.22, 1, 0.36, 1)` height reveal, arrow-key navigation, `inert` collapsed groups, and mobile `Sections` drawer trigger (`apps/web/src/components/LeftNavRail.tsx`).

### Signature Components
- **Bilingual Manuscript (`DocumentEditor`):** `794px` / `1056px` paper canvas with horizontal table wrappers and atomic linked-metric pills (`apps/web/src/components/DocumentEditor.tsx`).
- **Version & Audit Drawer (`VersionAuditDrawer`):** `480px` slide-over (`100vw` mobile) with WAI-ARIA tabs, inline two-step `Confirm Restore`, and `audit:read` Viewer notices (`apps/web/src/components/VersionAuditDrawer.tsx`).
- **AI & Voice Dock (`AiVoicePanel`):** Bottom shelf with explicit `isMock: true` badge, 2-line selection excerpt, `Ctrl+K`/`Ctrl+Enter` shortcuts, and mandatory diff approval (`apps/web/src/components/AiVoicePanel.tsx`).

## Do's and Don'ts

### Do:
- **Do** pair `Kantumruy Pro` and `Noto Sans Khmer` with `0em` letter-spacing, `1.8` body line-height, and `1.65` heading line-height so stacked Khmer subscripts never clip.
- **Do** enforce `44px` minimum target heights on interactive controls under `<= 640px` and `pointer: coarse` (`32px` desktop).
- **Do** disclose `isMock: true` speech adapters, `Planned` studios, `Reference Benchmark` sub-panels, and RBAC restrictions inline alongside disabled controls.
- **Do** use full `1px` perimeter borders and inline two-step confirmation before executing version restores.

### Don't:
- **Don't** apply negative tracking, fixed pixel height clipping, or unbundled font weights to Khmer text or selection excerpts.
- **Don't** decorate cards or diffs with one-sided stripe borders, decorative blurs, or gradients outside the active left-rail header state.
- **Don't** share clickable button cursor styles on `<textarea>`/`<select>` fields, or let mobile navigation toggles appear above `960px`.
- **Don't** sandwich narrow phone viewports into fixed heights that obscure the editorial sheet beneath the AI dock.
