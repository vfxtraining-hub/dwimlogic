# DWIM Logic

AI production agency. Do What I Mean.

## Layout
- `index.html` : the deployable single-page site (images inlined, meta tags, favicon)
- `site.src.html` + `build_site.py` : source template and build script (`python3 build_site.py` writes `site.html` and `index.html`)
- `editbox/` + `EDITBOX.md` : The Edit Box at `/editbox` (landing, client portal, editor studio, agent API, live Node server). See `EDITBOX.md`.
- `site.html` : fragment version used for the Claude artifact preview
- `assets/` : generated key art and the lookbook stills (`assets/README.md` lists prompts and generation IDs)
- `lookbook.html`, `build_lookbook.py` : Phase A review page for the reel
- `offer-sheet.html` / `offer-sheet.pdf` : one-page offer sheet
- `brief-intake.html` : structured brief that builds a copyable plain-text brief
- `PLAN.md` business plan, `RESEARCH.md` market and design research, `LAUNCH.md` 14-day sprint
- `EPIC_REEL.md` the generated reel plan, `PROOF_REEL.md` the earlier filmed concept (superseded), `reel-graphics.html` making-of timer graphics

## Deploy
Static. Host `index.html` anywhere (GitHub Pages, Netlify, Cloudflare Pages). Before launch:
1. Set `FORM_ENDPOINT` in `site.src.html` (for example a Formspree URL), then rebuild.
2. Confirm the `hello@dwimlogic.com` inbox.
3. Check Artlist's terms for commercial use of the generated key art.
