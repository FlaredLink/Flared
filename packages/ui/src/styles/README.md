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
