# Design System: InMotion Sport Clinic CRM

## 1. Purpose and source of truth

This document defines the visual and interaction system for the internal InMotion Sport Clinic CRM. It is the design source of truth for product design, Google Stitch generation, frontend implementation, review, and QA.

The CRM is a Russian-language, desktop-first web application for administrators, medical specialists, and clinic leadership. It combines leads, patients, medical cases, diagnostics, rehabilitation programs, scheduling, live queue, payments, tasks, documents, reports, permissions, and audit history.

When this document conflicts with a generic UI kit, generated mockup, framework default, or external reference, this document wins. Business behavior remains defined by `PRD.md`.

## 2. Visual theme and atmosphere

The interface combines two qualities:

- **Medical precision:** calm hierarchy, reliable states, readable clinical data, clear forms, and restrained surfaces.
- **Sports energy:** strong navigation, condensed performance numerals, visible progress, and rare dynamic red brand markers.

The product must feel like a professional rehabilitation operations center, not a generic hospital system, fitness application, or marketing website.

Design intensity:

- **Density:** 6/10 — balanced daily-use application. Tables and schedules are compact; forms and patient records have more breathing room.
- **Variance:** 3/10 — predictable grid with limited asymmetry used to establish priority.
- **Motion:** 4/10 — slightly below moderate. Motion clarifies state changes without drawing attention to itself.
- **Surface character:** soft clinical cards over a cool light canvas.
- **Primary platform:** desktop web, optimized first for `1366 × 768` and then wider screens.

## 3. Brand interpretation

There is no formal clinic brand book. The visual system is derived from the InMotion logo, the clinic Instagram, the approved CRM concept, and the agreed references.

Brand signals retained from the clinic:

- deep ink and navy foundations;
- cool medical blue;
- white typography and surfaces;
- a vivid red motion mark;
- a balance of rehabilitation medicine and athletic performance.

The Instagram feed is a brand reference, not a direct UI theme. The CRM uses a light working canvas because staff will read and edit dense information for long periods.

External references influence modular composition, spacing, and card hierarchy only. Do not copy their branding, layouts, or color systems literally.

## 4. Application shell and layout

### 4.1 Desktop shell

- Full-height left navigation: `240px` expanded, `72px` collapsed.
- Top context bar: `64px` high.
- Main content uses a responsive 12-column CSS Grid.
- Main page gutters: `24px` at widths of `1440px` and above; `20px` at the minimum supported width.
- Grid gap: `16px` for dashboard modules; `20px` for major page regions.
- Maximum content width is not artificially constrained inside the authenticated CRM. Operational screens use the available viewport.
- Horizontal page scrolling is forbidden at supported resolutions. Wide tables scroll inside a clearly bounded table region only when unavoidable.

### 4.2 Navigation

Navigation is grouped by domain and uses collapsible sections:

1. Overview
2. Patients and medical work
3. Schedule and queue
4. Leads and communications
5. Finance
6. Tasks and documents
7. Reports and audit
8. Administration

Rules:

- Expanded mode shows icon and label.
- Collapsed mode shows icons with accessible tooltips.
- The active item uses a soft blue field, stronger label weight, and a thin brand-red marker.
- Expanded/collapsed preference persists per user.
- Permission-restricted sections are not rendered.
- The user must never infer a hidden medical or financial entity from navigation counters.

### 4.3 Top context bar

Contains:

- page context or clinic selector when relevant;
- global search;
- one page-level primary action;
- notifications;
- user identity, role, and session actions.

Global search is visually central but does not dominate the page. Search results always respect permissions.

## 5. Role-based workspaces

The system ships with three safe dashboard presets.

### 5.1 Administrator dashboard

Prioritizes:

- today's schedule;
- arrivals and live queue;
- new leads and follow-ups;
- confirmations, cancellations, and no-shows;
- payments and debts;
- rooms and specialist availability;
- personal tasks and required actions.

### 5.2 Medical specialist dashboard

Prioritizes:

- today's appointments;
- active assigned cases;
- programs requiring review;
- patient deterioration warnings;
- control points and incomplete records;
- personal tasks;
- recent patient dynamics.

### 5.3 Leadership dashboard

Prioritizes:

- clinic workload;
- lead conversion;
- completed visits and no-shows;
- revenue, payments, refunds, and debt;
- specialist and room utilization;
- approval requests;
- operational and clinical risk events.

### 5.4 User customization

- Users may hide, reorder, and resize only widgets available to their role and permissions.
- Permissions govern both widget visibility and the data rendered inside it.
- Each role has a restore-default-layout action.
- Layout changes are saved per user.
- A widget must never briefly render restricted data while permissions are loading.

## 6. Color palette and roles

### 6.1 Primitive palette

| Token | Value | Role |
|---|---:|---|
| Ink Navy 950 | `#071F3D` | Navigation foundation, highest-contrast brand surface |
| Action Navy 800 | `#0B3A6E` | Primary buttons and primary selected controls |
| Clinical Blue 600 | `#2F6FED` | Links, focus, charts, selected states |
| Brand Red 600 | `#E23B46` | Logo and rare brand markers only |
| Canvas 50 | `#F4F7FB` | Application background |
| Surface 0 | `#FFFFFF` | Cards, forms, tables, overlays |
| Medical Surface 100 | `#EDF4FC` | Clinical grouping and informational surfaces |
| Text 950 | `#142033` | Primary text |
| Text 600 | `#66758A` | Secondary text and metadata |
| Border 200 | `#DCE5F0` | Dividers and component borders |
| Success 700 | `#16835D` | Confirmed, completed, healthy progression |
| Warning 800 | `#8A5200` | Warning text and icons on light surfaces |
| Warning Surface 100 | `#FFF5E6` | Warning background |
| Destructive 700 | `#B4232C` | Errors and destructive actions |
| Destructive Surface 100 | `#FDECEE` | Error background |

### 6.2 Semantic roles

- `primary`: Action Navy 800
- `primary-foreground`: Surface 0
- `link`: Clinical Blue 600
- `focus-ring`: Clinical Blue 600
- `background`: Canvas 50
- `surface`: Surface 0
- `surface-medical`: Medical Surface 100
- `foreground`: Text 950
- `muted-foreground`: Text 600
- `border`: Border 200
- `success`: Success 700
- `warning`: Warning 800
- `destructive`: Destructive 700
- `brand-marker`: Brand Red 600

### 6.3 Color discipline

- Clinical Blue is the single interactive accent.
- Brand Red is not a general CTA color.
- Brand Red must not indicate destructive behavior by itself.
- Destructive states always include explicit text and an icon.
- Status meaning never relies on color alone.
- Avoid large saturated fields. Strong color is reserved for navigation, primary actions, focus, and critical status communication.
- Gradients are not part of the core application UI.

### 6.4 Contrast baseline

Verified contrast ratios against white:

- Ink Navy: `16.50:1`
- Action Navy: `11.38:1`
- Clinical Blue: `4.55:1`
- Primary text: `16.35:1`
- Secondary text: `4.69:1`
- Success: `4.73:1`
- Destructive: `6.53:1`

Use Warning 800 for warning text. Lighter oranges may be used only as non-text surfaces or decorative status markers.

## 7. Token architecture

Use three layers. Components must never reference raw hex values directly.

```css
:root {
  /* Primitive */
  --ink-navy-950: #071f3d;
  --action-navy-800: #0b3a6e;
  --clinical-blue-600: #2f6fed;
  --brand-red-600: #e23b46;
  --canvas-50: #f4f7fb;
  --surface-0: #ffffff;
  --medical-surface-100: #edf4fc;
  --text-950: #142033;
  --text-600: #66758a;
  --border-200: #dce5f0;
  --success-700: #16835d;
  --warning-800: #8a5200;
  --destructive-700: #b4232c;

  /* Semantic */
  --color-background: var(--canvas-50);
  --color-surface: var(--surface-0);
  --color-surface-medical: var(--medical-surface-100);
  --color-foreground: var(--text-950);
  --color-muted-foreground: var(--text-600);
  --color-primary: var(--action-navy-800);
  --color-link: var(--clinical-blue-600);
  --color-focus-ring: var(--clinical-blue-600);
  --color-brand-marker: var(--brand-red-600);
  --color-border: var(--border-200);
  --color-success: var(--success-700);
  --color-warning: var(--warning-800);
  --color-destructive: var(--destructive-700);

  /* Component examples */
  --sidebar-bg: var(--ink-navy-950);
  --button-primary-bg: var(--color-primary);
  --button-primary-fg: var(--surface-0);
  --input-focus-ring: var(--color-focus-ring);
  --card-bg: var(--color-surface);
  --card-border: var(--color-border);
  --schedule-current-line: var(--color-brand-marker);
}
```

## 8. Typography

### 8.1 Families

- **Interface and body:** `Manrope`, with `Arial`, sans-serif fallback.
- **Performance numerals and selected headings:** `Roboto Condensed`, with `Arial Narrow`, sans-serif fallback.
- Serif typefaces are forbidden in the authenticated CRM.

### 8.2 Scale

| Role | Size | Weight | Line height |
|---|---:|---:|---:|
| Page title | `28px` | 700 | `36px` |
| Section title | `20px` | 650 | `28px` |
| Card title | `16px` | 650 | `24px` |
| Body comfortable | `16px` | 400 | `24px` |
| Body default | `14px` | 400 | `21px` |
| Label | `13px` | 600 | `18px` |
| Metadata | `12px` | 500 | `16px` |
| KPI large | `32px` | 600 | `36px` |
| Queue timer | `40px` | 600 | `44px` |

Rules:

- Medical long-form content uses `15–16px` text and at least `1.5` line height.
- Tabular numbers use `font-variant-numeric: tabular-nums`.
- Roboto Condensed is used sparingly for KPI, timers, case numbers, and compact performance labels.
- Do not use all caps for paragraphs, navigation, field labels, or buttons.
- Text truncation requires an accessible way to reveal the full value.

## 9. Spacing, shape, and elevation

### 9.1 Spacing scale

Base unit: `4px`.

`4, 8, 12, 16, 20, 24, 32, 40, 48, 64`

Common assignments:

- icon-to-label gap: `8px`;
- field label to control: `8px`;
- related controls: `12px`;
- card internal padding: `16–20px`;
- major form section padding: `24px`;
- page section gap: `24–32px`.

### 9.2 Radius

- cards and large panels: `14–16px`;
- inputs, buttons, compact panels: `10px`;
- badges: `8px`, not fully pill-shaped unless representing a compact status/filter;
- avatars: circular.

### 9.3 Elevation

- Base cards use a border and very soft cool shadow.
- Tables inside cards do not add another shadow.
- Dropdowns and popovers use elevation level 2.
- Dialogs and side sheets use elevation level 3 with a `40–55%` neutral scrim.
- Shadows are cool-neutral, never black-heavy or glowing.

## 10. Icons and imagery

- Use one consistent outline icon family: Phosphor Icons, regular weight.
- Standard icon sizes: `16`, `20`, and `24px`.
- Icons are always SVG/vector; emojis are forbidden as interface icons.
- Icon-only buttons require an accessible name and at least a `44 × 44px` hit area.
- Clinic and third-party logos use official assets without distortion or improvised recoloring.

Imagery is functional only:

- anatomical diagrams;
- body-zone selection;
- exercise demonstrations;
- diagnostic explanations;
- patient avatars when available and permitted.

Do not add decorative sports photography to dashboards, forms, empty states, or medical records.

## 11. Component styling

### 11.1 Buttons

- Primary: Action Navy background, white label, `10px` radius.
- Secondary: white surface, Border 200 outline, Text 950 label.
- Ghost: transparent, visible hover field.
- Destructive: Destructive 700, used only after clear intent.
- One primary action per page region.
- Loading preserves button width, disables repeat submission, and shows progress without shifting the label layout.
- Active feedback: `translateY(1px)` or subtle opacity change; no elastic overshoot.

### 11.2 Cards

- Soft white or Medical Surface fill.
- `14–16px` radius.
- Thin border and restrained cool shadow.
- Titles align with actions consistently.
- Cards group related information; they are not used to wrap every row or label.
- Nested cards are forbidden. Use dividers, grouped fields, or tinted subsections instead.

### 11.3 Inputs and forms

- Visible label above every field.
- Helper text below when necessary.
- Error appears below the relevant field and explains how to fix it.
- Default control height: `44px`; compact filters may use `36–40px`.
- Focus ring: `2px` Clinical Blue with clear offset.
- Read-only and disabled states must be visually and semantically distinct.
- Forms use logical sections and two columns only when fields remain easy to scan.
- Long forms have a sticky save/action bar.
- Unsaved changes trigger a clear exit warning.

### 11.4 Tables

- Default row height: `44–48px`.
- Header remains visible in long table regions.
- Sorting, filters, visible-column controls, pagination, and export appear in predictable locations.
- Hover identifies the row but does not replace selection.
- Selected rows use a pale blue fill plus checkbox state.
- Dense medical or financial tables must not use zebra striping and colored status fills simultaneously.
- Numeric columns align right; labels align left; tabular figures are mandatory.
- Empty, loading, error, and no-access states occupy the table region without changing its surrounding layout.

### 11.5 Status badges

- Neutral light background.
- Meaning shown through label plus a colored dot, icon, or thin leading strip.
- Avoid fully saturated badge backgrounds.
- Red is reserved for overdue, blocked, destructive, or clinically critical meaning and must include explicit text.

### 11.6 Tabs and segmented controls

- Tabs represent peer sections of one entity.
- Segmented controls switch view modes such as Day/Week.
- Active state uses weight, Clinical Blue, and a structural marker.
- Avoid using tabs as a substitute for primary navigation.

### 11.7 Notifications

- Informational notices are calm and dismissible.
- Required actions include severity, deadline, linked entity, and a direct action.
- Medical and financial content is excluded when the recipient lacks permission.
- Toasts do not steal focus and use an accessible live region.

### 11.8 Loading and empty states

- Use skeletons matching final card, table, and form geometry.
- Use a determinate progress indicator for exports and long reports when progress is known.
- Empty states contain a concise explanation and one relevant action.
- Decorative stock photography and generic illustrations are forbidden.

## 12. Domain-specific patterns

### 12.1 Schedule

- Time remains visible along the left edge.
- Current time uses a thin Brand Red line with a time label.
- Appointments use pale semantic surfaces with text labels; color alone never communicates status.
- The selected appointment opens a quick-view side panel without losing calendar context.
- Drag-and-drop is optional convenience; every move must also be possible through an explicit action.
- Conflicts display the exact resource, time, and recovery options.

### 12.2 Live queue

- Shows patient, planned time, arrival time, wait duration, specialist, room, and state.
- Waiting duration uses condensed tabular numerals.
- Escalating delay changes marker and label, not the entire background.
- The primary action stays operational: start, call, assign, or resolve delay.

### 12.3 Patient record

- Header shows identity, age, contacts allowed by permission, responsible specialist, consent state, major risks, and debt.
- Content uses stable tabs: Overview, Cases, Appointments, Payments, Documents, Consents, History.
- Clinical risks and consent blocks are visible before edit actions.
- The chronological history uses a single ordered timeline with filters.

### 12.4 Medical case

Use the lifecycle:

`Обращение → Диагностика → Планирование → Курс → Контроль → Завершение`

The case view includes:

- current stage and blockers;
- responsible team;
- goals and progress;
- diagnostics and tests;
- current program version;
- upcoming control point;
- chronological activity feed.

The lifecycle is a functional progress component, not decoration.

### 12.5 Appointment workflow

- Current complaints and change since last visit appear first.
- Medical entry occupies the main column.
- Recommendations and next action remain visible in a supporting panel.
- Required fields are marked before submit.
- Completing the visit uses a clear review step and blocks duplicate submission.

### 12.6 Charts

- Recharts visualizations use Clinical Blue as the main series.
- Success, warning, and destructive colors appear only when semantically required.
- Trend charts use lines; comparisons use bars; proportions use donut charts only for five or fewer categories.
- Every chart includes units, time range, readable labels, tooltips, and a text/table alternative.
- Avoid heavy gradients, 3D charts, ornamental grid lines, and animated chart entrances longer than `300ms`.

## 13. Motion and interaction

Motion is supportive, brief, and interruptible.

Timing:

- hover and pressed feedback: `120–160ms`;
- menus, popovers, tooltips: `140–180ms`;
- drawers, dialogs, and tab content: `180–240ms`;
- chart updates: `200–300ms` maximum.

Easing:

- enter: restrained ease-out;
- exit: faster ease-in;
- no bounce, elastic, or dramatic spring effects in operational screens.

Rules:

- Animate only `transform` and `opacity` where possible.
- Do not animate table rows as a cascade.
- Do not animate counters continuously.
- No perpetual loops, pulsing cards, floating panels, or decorative background motion.
- Respect `prefers-reduced-motion` and provide an immediate state change.
- User input remains available during non-blocking transitions.

## 14. Responsive behavior

The first version is desktop-first and does not promise full smartphone operation.

Supported design targets:

- Minimum: `1366 × 768`.
- Standard: `1440 × 900`.
- Wide: `1920 × 1080` and larger.

Behavior:

- At minimum width, sidebar may collapse to icon mode and dashboard columns reflow.
- Critical primary actions remain visible.
- Schedule and data tables preserve labels and do not shrink text below the defined scale.
- Wider screens add useful columns and whitespace; they do not inflate typography or card radius.
- Browser zoom up to `200%` must preserve access to content and actions, even if internal table scrolling becomes necessary.

## 15. Accessibility

- WCAG 2.2 AA is the baseline.
- Normal text contrast is at least `4.5:1`; large text and meaningful graphical elements at least `3:1`.
- All workflows are keyboard operable.
- Focus order follows visual order.
- Visible focus is never removed.
- Icon-only controls have names and tooltips.
- Errors are announced and placed near the relevant field.
- Modals trap focus and return it to the trigger when closed.
- Route changes move focus to the page heading.
- Status, urgency, trends, and chart series are not communicated by color alone.
- Touch/click targets are at least `44 × 44px` for primary interactive controls.
- Reduced motion is supported.

## 16. Permissions, privacy, and safety in UI

- Hidden data is not replaced with revealing counts, names, snippets, or layout flashes.
- Skeletons for restricted data must not reveal field structure that itself is sensitive.
- Export and audit actions show their scope before execution.
- Destructive and irreversible operations use explicit entity names and consequences.
- High-risk operations require review without relying on red styling alone.
- The demo environment is visually identified but never styled like an error state.
- Session expiry warning preserves draft recovery guidance.

## 17. Content and microcopy

- Interface language is Russian.
- Dates: `ДД.ММ.ГГГГ`.
- Time: 24-hour format.
- Currency: tenge with locale-aware grouping, for example `1 248 000 ₸`.
- Labels use concrete clinic terminology from `PRD.md`.
- Buttons start with a clear verb: `Создать запись`, `Завершить приём`, `Сформировать документ`.
- Error messages state the cause and the recovery action.
- Avoid promotional language, vague wellness phrases, and technical implementation terms.
- Use realistic Kazakhstani names in demo data; never use generic placeholders such as “John Doe”.

## 18. Explicit anti-patterns

Never use:

- dark mode as the default working theme;
- glassmorphism or translucent cards;
- neon, purple AI gradients, glow borders, or gradient text;
- pure black;
- Brand Red as the universal CTA color;
- red/green as the only distinction between states;
- fully saturated status pills across dense screens;
- emojis as structural icons;
- mixed icon families;
- decorative sports photography in operational UI;
- nested cards or a card around every row;
- three identical KPI cards repeated without hierarchy;
- oversized marketing typography inside the CRM;
- centered marketing hero sections;
- overlapping UI elements or floating decorative panels;
- hidden labels, placeholder-only forms, or floating labels;
- automatic carousels, marquees, or perpetual animation;
- layout-changing hover effects;
- unbounded modals for long workflows;
- destructive actions next to routine actions without separation;
- fake round-number KPIs or generic placeholder names;
- unexplained abbreviations in patient-facing or cross-role screens.

## 19. Design acceptance checklist

A screen is ready for implementation only when:

- its primary task is clear within five seconds;
- one primary action is visually dominant;
- permissions are reflected in both actions and data;
- loading, empty, error, no-access, and success states are defined;
- keyboard focus and reading order are clear;
- text and graphical contrast meet WCAG AA;
- status is not communicated by color alone;
- table and schedule density remains usable at `1366 × 768`;
- long Russian labels do not break the layout;
- medical and financial values use explicit units and formats;
- destructive actions explain consequences;
- animation stays within the motion limits;
- all colors, spacing, typography, radius, and shadows use tokens;
- the result visually belongs to InMotion Sport Clinic.
