# Game Asset Inventory

This file identifies game-derived resources packaged for the Arknights: Endfield map and skin experience. These resources are not covered by the MIT License in [`LICENSE`](LICENSE).

## Excluded paths

- `lib/endfield-map/resources/*.png`
- `lib/endfield-map/resources/*.json.br`
- `lib/endfield-map/resources/*.json.gz`
- `lib/rhine/assets/archive-cassette.glb` — from LBEILC/RhineLabUI;
  the upstream model is not covered by its code's MIT license. See
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md#rhine-lab-archive-browser).
- `lib/rhine/assets/archive-assembly.glb` — the same upstream's assembly model,
  under the same exclusions.

The Brotli (`.br`) and gzip (`.gz`) files are alternate compressed representations of map data and may include serialized geometry, materials, textures, or related presentation data used by the skin.

The following project-authored implementation files are not part of this exclusion and remain covered by the MIT License:

- `lib/endfield-map/map.js.br`
- `lib/endfield-map/map.js.gz`
- the source code that loads, renders, and integrates the map and skin

Arknights: Endfield and all related names, trademarks, artwork, models, textures, game data, and other game materials belong to their respective rights holders. Their presence in this package does not grant permission to extract, reuse, modify, sublicense, or redistribute them independently.

This is an unofficial community project and is not affiliated with or endorsed by the game's developers or publishers.
