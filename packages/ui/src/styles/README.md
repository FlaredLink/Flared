# Flared styles

`index.css` loads three files in order:

- `kumo-tokens.css`: Cloudflare Kumo semantic tokens, vendored under MIT. The license is in `KUMO-LICENSE.txt`; keep it when updating.
- `tokens.css`: Flared design roles over those tokens.
- `base.css`: element defaults.

Each app imports `@flared/ui/styles` once and adds its own shell, navigation, and pages.

Kumo source: https://github.com/cloudflare/kumo/blob/8a8535b0d5fc9d90c37b12aad2b92fe3d092f008/packages/kumo/src/styles/theme-kumo.css

Only the `@theme` wrappers are changed to `:root`, so the published semantic variables work without Tailwind or React. These are not Kumo React components.

Cloudflare orange is the brand accent; Kumo blue remains the accessible focus color. Primary buttons use white text and icons on a deeper orange (`#c94b00`, 4.68:1 contrast), darkening on hover without reducing opacity.

Page, section, panel, and field backgrounds are pure white (`#ffffff`). Do not add grey, warm-white, beige, or cream background washes; separate regions with hairline borders. Text and neutral elements use hue-free matte black and dark grey. Hover states and progress tracks use the soft brand tint.
