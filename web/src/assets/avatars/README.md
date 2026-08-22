# Avatar portraits

Thirty pre-rendered voxel-art portraits, one per id in `avatarIcons.tsx`. They
are committed art, not a runtime dependency: nothing in Parley talks to
api.dicebear.com, which from a self-hosted app would be one third-party request
per person per render.

- **Tool** — `@dicebear/core` 10.6.1 with the `voxel-art` definition from
  `@dicebear/styles` 10.5.0 (the same pair the `dicebear` 10.6.1 CLI uses),
  run once at author time.
- **Style** — `voxel-art`, CC0 1.0. See `NOTICE`.
- **Seed** — the id itself, so `ada.svg` is `{ seed: "ada" }` and the set is
  reproducible from the filenames alone. Options are the style's defaults.
- **Post-processing** — the generator comment and `<metadata>` block are
  dropped, the full-bleed background `<rect>` is dropped so the identity-hue
  disc shows through, and the `viewBox` is narrowed from `0 0 128 128` to
  `22 10 92 92` to crop the full-body figure down to a head-and-shoulders
  portrait that survives 38px.
- **Minification** — a one-off `npx svgo --multipass` pass with
  `removeViewBox` disabled, run over the finished set. It only drops
  metadata, whitespace, default attributes and redundant precision, and
  shortens the `<defs>` ids; every portrait renders pixel-for-pixel
  identically. Re-run it by hand if a portrait is ever regenerated — SVGO is
  not a dependency and not a build step.

## Changing a portrait

Two things are pinned to the bytes of these files, and both have to be redone
by hand:

1. **The digest manifest.** `portraits.sha256` holds a sha256 per file and
   `../../components/avatarIcons.test.tsx` checks it, so a lossy SVGO pass or a
   botched re-export fails CI instead of shipping silently.
   `cd web/src/assets/avatars && sha256sum *.svg > portraits.sha256`
2. **The legibility contact sheet.** All thirty portraits at 46px and 38px, in
   both themes, on `--color-surface`:
   `cd web && npm install --no-save @resvg/resvg-js && node scripts/portrait-contact-sheet.mjs`
   Then look at the result at 100% and update the verdict in
   `site/src/content/docs/project/contrast.mdx`.

Ids are the wire format. The twelve retired ones — parrot, kraken, anchor,
lighthouse, wheel, gull, buoy, crate, rubber-duck, coffee, terminal, pager —
must never be reused.

There is no generator script on purpose. Write one when a second batch is
actually needed; until then the four facts above are the whole recipe.
