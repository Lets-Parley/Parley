# Marketplace store listing kit

Ready-made assets and paste-ready text for the Marketplace SDK's **Store
listing** tab (see [google-meet.mdx](../../../site/src/content/docs/operations/google-meet.mdx)
step 5). The goal is to make that step mostly copy-paste instead of a blank
form.

Asset requirements below are quoted from Google's own
[Create a store listing](https://developers.google.com/workspace/marketplace/create-listing)
page, fetched 2026-09-23. Google's page does not state a required file
format or a file size limit for any of these — the requirements it does
state are pixel dimensions and text-length limits only, quoted here per
Google's create-listing page. These assets are PNG because it is lossless
and universally accepted; that choice is ours, not Google's.

The maintainer is separately confirming which of these fields a **Private**
listing actually enforces in the console. Until that's folded in, treat
every requirement below as "per Google's create-listing page" rather than
as independently verified against a real listing.

## Icons (`icon-*.png`)

> "Requires at least two sizes: 32x32 and 128x128 pixels. If your project
> includes a web app, you also need 48x48 and 96x96 pixels."

All four sizes are provided, rendered from Parley's existing mark
(`web/public/favicon.svg`) at each required size.

## Card banner (`card-banner.png`, source `card-banner.svg`)

> "Required size: 220x140 pixels."

A simple on-brand banner: Parley's mark plus wordmark on the product's own
navy (`#1D4E6E`). Not a screenshot — a marketing graphic, same as the icon.

## Screenshots (`screenshot-*.png`)

> "Requires at least one screenshot showing your app's integration with
> Google services, but you can provide up to 10. The recommended size is
> 1280x800 pixels, though 640x400 or 2560x1600 pixels are also accepted.
> Screenshots should have square corners and no padding (full bleed)."

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

Application name, short description, detailed description and a suggested
category, all within Google's stated limits:

> Application name: "Limit the name to 50 characters or less"
> Short description: "200 character limit"
> Detailed description: "Limit this to less than 16,000 characters"

Google's page does not enumerate the category dropdown's options, so
`listing.md` names a category to try, not a verified exact label.

## What you still have to bring yourself

**Terms of service, privacy policy and support URLs are the operator's
own** — Parley has no hosted legal pages to offer here, and the store
listing needs pages that actually describe your own instance and how your
own organization supports it. See `listing.md` for what to put there.

## Regenerating

`generate.sh` rebuilds every PNG in this directory from
`web/public/favicon.svg`, `card-banner.svg` and the `site/src/assets`
screenshots. It needs ImageMagick's `convert` and Python 3 with Pillow — both
already used elsewhere on a Parley contributor's machine (Pillow is not a
new project dependency; nothing here is imported by `setup.sh` or shipped in
the binary). Re-run it after `web/public/favicon.svg` changes, or after the source
screenshots in `site/src/assets/` are reshot.
