# Flared styles

`index.css` loads three files in order:

- `kumo-tokens.css`: Cloudflare Kumo semantic tokens, vendored under MIT. The license is in `KUMO-LICENSE.txt`; keep it when updating.
- `tokens.css`: Flared design roles over those tokens.
- `base.css`: element defaults.

Each app imports `@flared/ui/styles` once and adds its own shell, navigation, and pages. `@flared/ui/styles/controls` adds the shared page container, skip link, button row, and eyebrow text. Buttons are the `Button` and `IconButton` atoms.

Kumo source: https://github.com/cloudflare/kumo/blob/8a8535b0d5fc9d90c37b12aad2b92fe3d092f008/packages/kumo/src/styles/theme-kumo.css

Only the `@theme` wrappers are changed to `:root`, so the published semantic variables work without Tailwind or React. These are not Kumo React components.

Coral (`--color-accent`) marks focus rings (2px, at least 3:1 on every surface) and brand moments only. A chosen option, the current navigation item, and a selected row use a raised surface with `--shadow-ring`, or ink. Primary actions are ink black with white text, and white with black text in dark mode. Text actions use `--color-link`, which is ink with an underline.

The main area and panels are white (`--color-paper`, `--color-surface`). The frame behind them, such as the sidebar and the sign-in pages, uses the off-white `--color-canvas`. Fields, tracks, and hover rows use `--color-surface-2`; tiles and empty bars use `--color-surface-3`. Separate regions with `--color-rule` or the softer `--color-rule-soft`. Text uses one ink (`--color-strong`, `--color-ink`) and three greys: `--color-muted` (and `--color-lead`), `--color-subtle` for small grey text, which keeps 4.5:1 on every surface, and `--color-faint` for decoration only, never text.

## Token groups

- Dark values (`--dark-*`): the dark half of the roles that a dark panel inside a light page needs. Chrome resolves `light-dark()` where a custom property is declared, so such a panel maps its roles to these values. Change a dark value here, and the role and the panel both follow.
- Charts: click bars are ink at 16% (`color-mix` with `--color-strong`), solid under the pointer, and today's bar is striped in `--color-faint`. Breakdown rows have a `--color-surface-2` bar behind them. Chart values show in `--color-tooltip` with `--color-on-tooltip` (dark in both themes). Coral is not a data colour.
- Fonts: Figtree (SIL OFL 1.1) for text, headings, and the wordmark (`--font-body`, `--font-display`, `--font-wordmark`); Geist Mono for code (`--font-mono`). Each app imports the font packages.
- Type: `--text-xs` (12px) to `--text-3xl` (24px), then `--text-heading` and `--text-display`. App body text is `--text-base` (15px); marketing body text is `--text-lg` (16px). Weights are `--weight-regular`, `--weight-medium`, `--weight-strong`, `--weight-heavy`, and `--weight-display`.
- Motion: `--dur-instant` (80ms) for press feedback, `--dur-fast` (140ms) for hover, menus, and tooltips, `--dur-base` (220ms) for dialogs, panels, and list rows, and `--dur-slow` (320ms) for chart values. An exit runs at about 70 percent of its enter duration. Use `--ease-out` to enter, `--ease-in` to exit, and `--ease-in-out` to move or resize.
- Elevation: `--shadow-ring` draws a card or field edge as a 1px ring with a short drop in light mode. `--shadow-raised` adds a longer soft drop in light mode only. `--shadow-lift` is for menus, dialogs, and panels over the page.
- Layers: `--z-sidebar`, `--z-header`, `--z-panel`, and `--z-skip-link`. Native dialogs and popovers use the top layer and need no value.

## Shell hooks

An app shell sets these custom properties on its main area; the shared components read them and work without them.

- `--page-bleed`: how far the `PageHeader` bar reaches past the content on each side, so it runs from edge to edge of the main area. A docked `SidePanel` and a phone `LinkList` reach the same edges. Default 0.
- `--page-top`: the main area's top padding, which the bar covers. Default 0.
- `--page-bottom`: the main area's bottom padding, which a docked `SidePanel` reaches past. Default 0.
- `--page-bar-position`: `sticky` keeps the bar at the top while the page scrolls. Default `relative`.
- `--page-background`: the colour behind the bar. Default `--color-paper`.
- `[data-page-bar]` marks the bar, so a shell can tell whether a page has one (for example, to pad the top of a page without it).
- A container (`container-type: inline-size`) narrower than 4.5rem, such as a collapsed sidebar, makes a `Menu` text trigger show only its lead.

`SplitView` with `dockAt` turns its `SidePanel` into a column beside the content once the view is that many pixels wide; the column sticks under the 3.75rem page bar.

Component hooks: `--site-icon-size` sets a `SiteIcon` tile's edge, and `--sparkline-color`, `--sparkline-gap`, and `--sparkline-radius` style `Sparkline` bars.

Below 48rem, `PageHeader` is a phone top bar (a back button on a pushed screen) and `Dialog` is a bottom sheet. Both clear the safe areas of `viewport-fit=cover`.

## Atomic layers

- Atoms (`src/atoms/`, `src/icons/Glyph.svelte`): Button, IconButton, Badge, StatusDot, Kbd, Avatar, Checkbox, TextInput, Select, Meter. Each atom styles itself; it needs only the roles above.
- Molecules (`src/molecules/`): Breadcrumbs, PageHeader, SectionHeader, Tabs, SegmentedControl, SettingRow, CopyButton, CopyField, SidePanel, SplitView, Menu, Callout, Stepper, ChoiceCard, Sparkline, Dialog, FormField.
- Organisms: the feature folders (`links/`, `domains/`, `tokens/`, `oauth/`, `analytics/`, and the rest). They compose atoms and molecules and talk to the API.
- Templates and pages: each app's shell and routes.

`Glyph` holds Phosphor regular icons (MIT, `analytics/PHOSPHOR-LICENSE.txt`). Add an icon by copying its regular-weight path from Phosphor.
