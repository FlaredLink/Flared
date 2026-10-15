# Flared styles

`index.css` loads three files in order:

- `kumo-tokens.css`: Cloudflare Kumo semantic tokens, vendored under MIT. The license is in `KUMO-LICENSE.txt`; keep it when updating.
- `tokens.css`: Flared design roles over those tokens.
- `base.css`: element defaults.

Each app imports `@flared/ui/styles` once and adds its own shell, navigation, and pages. `@flared/ui/styles/controls` adds the shared page container, skip link, buttons, icon buttons, and eyebrow text.

Kumo source: https://github.com/cloudflare/kumo/blob/8a8535b0d5fc9d90c37b12aad2b92fe3d092f008/packages/kumo/src/styles/theme-kumo.css

Only the `@theme` wrappers are changed to `:root`, so the published semantic variables work without Tailwind or React. These are not Kumo React components.

Coral (`--color-accent`) marks what is active or chosen: the current navigation item, the selected tab, a checked box, a selected row. Primary actions are ink black with white text, and white with black text in dark mode. Text actions use `--color-link` (blue). Kumo blue remains the accessible focus color.

The main area and panels are white (`--color-paper`). The frame behind them, such as the sidebar and the sign-in pages, uses the cool off-white `--color-canvas`. Separate regions with hairline borders. Text and neutral elements use near-neutral black and grey.

## Token groups

- Dark values (`--dark-*`): the dark half of the roles that a dark panel inside a light page needs. Chrome resolves `light-dark()` where a custom property is declared, so such a panel maps its roles to these values. Change a dark value here, and the role and the panel both follow.
- Data (`--color-data-1`, `--color-data-2`, each with `-soft`): `data-1` is clicks and `data-2` is the previous period. Use them for chart marks and for the tinted bars behind breakdown rows. Coral is not a data colour. Charts also use `--color-chart-grid`, `--color-chart-cursor`, and `--color-tooltip` with `--color-on-tooltip` (dark in both themes).
- Type: `--text-xs` (12px) to `--text-3xl` (24px), then `--text-heading` and `--text-display`. App body text is `--text-base` (15px); marketing body text is `--text-lg` (16px). Weights are `--weight-regular`, `--weight-medium`, `--weight-strong`, `--weight-heavy`, and `--weight-display`.
- Motion: `--dur-instant` (80ms) for press feedback, `--dur-fast` (140ms) for hover, menus, and tooltips, `--dur-base` (220ms) for dialogs, panels, and list rows, and `--dur-slow` (320ms) for chart values. An exit runs at about 70 percent of its enter duration. Use `--ease-out` to enter, `--ease-in` to exit, and `--ease-in-out` to move or resize.
- Elevation: `--shadow-ring` draws a card edge as a 1px ring. `--shadow-raised` adds a short soft drop in light mode only. `--shadow-float` is for menus and dialogs.
- Layers: `--z-sidebar`, `--z-header`, `--z-panel`, and `--z-skip-link`. Native dialogs and popovers use the top layer and need no value.

## Atomic layers

- Atoms (`src/atoms/`, `src/icons/Glyph.svelte`): Button, IconButton, Badge, StatusDot, Kbd, Avatar, Checkbox, TextInput, Select, Meter. Each atom styles itself; it needs only the roles above.
- Molecules (`src/molecules/`): Breadcrumbs, PageHeader, SectionHeader, Tabs, SegmentedControl, SettingRow, CopyButton, CopyField, SidePanel, SplitView, Menu, Callout, Stepper, ChoiceCard, Sparkline, Dialog, FormField.
- Organisms: the feature folders (`links/`, `domains/`, `tokens/`, `oauth/`, `analytics/`, and the rest). They compose atoms and molecules and talk to the API.
- Templates and pages: each app's shell and routes.

`Glyph` holds Phosphor regular icons (MIT, `analytics/PHOSPHOR-LICENSE.txt`). Add an icon by copying its regular-weight path from Phosphor.
