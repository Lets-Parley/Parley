# Marketplace store listing kit

Ready-made assets and paste-ready text for the Marketplace SDK's **Store
listing** tab (see [google-meet.mdx](../../../site/src/content/docs/operations/google-meet.mdx)
step 6). The goal is to make that step mostly copy-paste instead of a blank
form.

Asset requirements below are quoted from Google's own
[Create a store listing](https://developers.google.com/workspace/marketplace/create-listing)
page, fetched 2026-09-23. Google's page does not state a required file
format or a file size limit for any of these — the requirements it does
state are pixel dimensions and text-length limits only. These assets are
PNG because it is lossless and universally accepted; that choice is ours,
not Google's.

A maintainer's own Store listing page (2026-09-23) confirmed which fields
it actually marks required versus optional — the split below is that, not
a guess from Google's docs alone:

**Required**: the App Details language entry (English — Application name,
Short description and Detailed description live inside it), Category,
Application Icon 32x32, Application Icon 128x128, Application Card Banner
220x140, at least one Screenshot, Terms of service URL, Privacy policy URL,
Support URL, and Regions (or tick "All Regions").

**Optional**: Pricing, Icon 48x48, Icon 96x96, YouTube promo videos, Setup
URL, Admin config URL, Help URL, Report issue URL, Draft testers.

## Icons (`icon-*.png`)

32x32 and 128x128 are required; 48x48 and 96x96 are optional (they only
matter for a "Web app" integration, which this add-on doesn't use — see
[google-meet.mdx](../../../site/src/content/docs/operations/google-meet.mdx)
step 4's App Integrations note). All four sizes are provided anyway,
rendered from Parley's existing mark (`web/public/favicon.svg`) — see
"Regenerating" below for why that render needs care.

## Card banner (`card-banner.png`, source `card-banner.svg`)

Required, 220x140 pixels.

A simple on-brand banner: Parley's mark plus wordmark on the product's own
navy (`#1D4E6E`). Not a screenshot — a marketing graphic, same as the icon.

## Screenshots (`screenshot-*.png`)

At least one is required; you can provide up to 10. Google's recommended
size is 1280x800 pixels (640x400 or 2560x1600 are also accepted), with
square corners and no padding (full bleed).

Three screenshots, all built from the site's own shipped product
screenshots (`site/src/assets/*.png`, tracked in
`site/src/assets/screenshots.json`), not staged or invented:

- `screenshot-mainstage-light.png` / `screenshot-mainstage-dark.png` — the
  presenter view a facilitator puts on the **main stage** for the whole
  call, from `present-light.png` / `present-dark.png`. The source is an
  ultra-wide 2880x900 crop; rather than cut real content out to force a
  1.6:1 ratio, each is scaled to fit 1280x800 and the canvas is padded with
  that screenshot's own background color, so nothing is cropped away and
  nothing is invented.
- `screenshot-poker.png` — the poker room the side panel's vote pad
  connects to, from `poker.png` (1280x837), scaled to fit and padded the
  same way.

## Text (`listing.md`)

The App Details language entry is required, and everything text-related
lives inside it: application name, short description and detailed
description, all within Google's stated limits. That row starts collapsed
("English —"); click it to expand **Edit Language**, paste the text in,
then click **Done**. **Publish** and **Save draft** both stay greyed out
until every required field is filled, including that hidden row — check
it first if either button looks disabled.

> Application name: "Limit the name to 50 characters or less"
> Short description: "200 character limit"
> Detailed description: "Limit this to less than 16,000 characters"

Category is required. Google's create-listing page doesn't enumerate the
dropdown's exact options; `listing.md` names the value to pick, read from
the real dropdown in the console (2026-09-23).

## What you still have to bring yourself

**Terms of service, Privacy policy and Support URLs are the operator's
own, and all three are required** — Parley has no hosted legal pages to
offer here, and the store listing needs pages that actually describe your
own instance and how your own organization supports it. See `listing.md`
for what to put there.

**Regions is also required** — tick "All Regions", or restrict to wherever
your organization actually operates. There's no ready-made answer here;
it's an operator choice, not something a kit can pre-fill.

## Regenerating

`generate.sh` rebuilds every PNG in this directory from
`web/public/favicon.svg`, `card-banner.svg` and the `site/src/assets`
screenshots. Re-run it after `web/public/favicon.svg` or `card-banner.svg`
changes, or after the source screenshots in `site/src/assets/` are reshot.

It needs ImageMagick's `convert` and Python 3 with Pillow for the
screenshots — both already used elsewhere on a Parley contributor's machine
(Pillow is not a new project dependency; nothing here is imported by
`setup.sh` or shipped in the binary).

**Icons and the card banner need a real SVG renderer, not ImageMagick's.**
ImageMagick's own SVG delegate mis-renders `transform="rotate(angle cx
cy)"` — it clipped and mispositioned the two playing cards in Parley's
mark, so every icon and the card banner came out wrong the first time this
kit shipped. `generate.sh` picks a working renderer itself:

1. **`rsvg-convert`**, if it's on `PATH` — it follows the SVG transform
   spec correctly, so nothing else is needed.
2. Otherwise, **headless Chromium**, driven by `render.mjs`. This needs two
   things set as environment variables, neither of which is a repo
   dependency:
   - `CHROMIUM_PATH`: a Chromium executable. If you have Playwright's
     browsers cached already (`~/.cache/ms-playwright/chromium-*`), point
     at the `chrome` binary inside one of those directories.
   - `PLAYWRIGHT_CORE_DIR`: a directory with `playwright-core` installed —
     for example a scratch directory where you've run
     `npm init -y && npm install playwright-core`. It is never installed
     into this repository.

   Example:

   ```sh
   CHROMIUM_PATH=~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
   PLAYWRIGHT_CORE_DIR=/tmp/pw-render \
     ./generate.sh
   ```

After regenerating, look at each PNG — a rendering bug like this one is
visual, not something a test catches.
