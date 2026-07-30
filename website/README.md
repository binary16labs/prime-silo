# Prime-Silo Marketing Website (`website/`)

Sovereign local-first AI Agent OS marketing site built with kinetic scroll-driven explode chapters (`anime.js v4`), an interactive **Sovereign Stack Silo** architecture diagram, an interactive **Live Agent Terminal** workflow simulator, an honest cost model calculator, a Neuro-Assist accessibility dock, and a zero-dependency build pipeline.

## Architectural Rules

- **NEVER EDIT `index.html` DIRECTLY.** `index.html` is generated server-side by `build.mjs`. Any direct edits to `index.html` will be overwritten on the next build.
- **Content Single Source of Truth:** Edit `content.json` for all copy, SEO metadata, JSON-LD, FAQ, roadmap items, and calculator inputs.
- **Template & Markup:** Edit `template.html` for structural HTML5 markup, inline Benny mascot symbols, and section templates.
- **Styles & Interactivity:** Edit `styles.css` for evolved earth-tone design tokens (`--alabaster`, `--moss`, `--rust`, `--sage`, `--taupe`), sticky chapter layouts, and Neuro-Assist overrides. Edit `app.js` for scroll choreography and interactive calculator logic.

## Build Loop

Run the zero-dependency Node build script from the repository root or inside `website/`:

```bash
node website/build.mjs
```

### What `build.mjs` Does

1. Reads repository version from `package.json` (`v1.15.2+`).
2. Validates `content.json` against safety checks:
   - Fails if any `[[COPY` placeholder markers remain.
   - Fails if any invalidated legacy claims (`98%`, `$2,363`, `$34`, `token tax`) appear.
   - Fails if root-absolute asset paths (`/prime-silo/`) appear (must use relative paths).
3. Renders `content.json` + `template.html` into semantic HTML5 `index.html` with a `GENERATED FILE` banner comment.
4. Generates `sitemap.xml` and `robots.txt`.

## Open Graph Card (`og-image.png`)

To regenerate `og-image.png` (1200×630 social share card):

1. Open `website/og-card.html` in your browser at 1200×630 viewport resolution.
2. Capture a screenshot and save as `website/og-image.png`.

## Deployment

Committed outputs (`index.html`, `sitemap.xml`, `robots.txt`, `styles.css`, `app.js`, `vendor/`) are published as-is on push to `main` via `.github/workflows/deploy-pages.yml`.
