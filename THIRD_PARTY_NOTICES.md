# Third-Party Notices

## Scope of the MIT License

Unless otherwise stated, the original source code and documentation in this repository are licensed under the MIT License in [`LICENSE`](LICENSE).

The MIT License does not apply to third-party names, trademarks, artwork, images, models, textures, game data, corpus data, or other materials identified below. Nothing in this repository grants permission to use those materials beyond rights granted by their respective rights holders or by applicable law.

## Arknights and Arknights: Endfield

Arknights, Arknights: Endfield, their names, trademarks, characters, artwork, images, models, textures, game data, and other game-related materials belong to their respective rights holders.

The game-derived models and textures used by the optional Arknights: Endfield skin are excluded from this repository's MIT License. The affected packaged files are listed in [`GAME_ASSETS.md`](GAME_ASSETS.md). The original plugin source code, UI code, and map-rendering implementation remain licensed under the MIT License unless a file states otherwise.

PRTS.chat and prts-terrarchive are unofficial community projects. They are not affiliated with, endorsed by, sponsored by, or otherwise officially connected with the developers or publishers of Arknights or Arknights: Endfield.

## Corpus datasets

The complete corpus datasets are not included in this Git repository or in the bundled plugin code. The plugin first obtains the current release identity and file digests from PRTS.chat; users may then explicitly download the digest-bound bytes from the listed ModelScope mirrors, with PRTS.chat as a fallback byte source:

- [PRTS.chat Arknights corpus](https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-arknights)
- [PRTS Arknights: Endfield corpus](https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-endfield)

Downloaded datasets retain their upstream licenses and notices, including the source declarations below and those on the corresponding ModelScope dataset pages. This repository's MIT License does not relicense corpus data.

## PRTS Wiki: Terra timeline (泰拉年表)

Timeline data comes from [PRTS Wiki's 泰拉年表](https://prts.wiki/w/%E6%B3%B0%E6%8B%89%E5%B9%B4%E8%A1%A8), authored by the editors identified in its [revision history](https://prts.wiki/index.php?title=%E6%B3%B0%E6%8B%89%E5%B9%B4%E8%A1%A8&action=history), under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). PRTS.chat extracts and structures event data and groups it by activity for retrieval. The source chronology is inferred from game stories and may contain errors or unfinished content; that limitation also applies to the processed data. This use does not imply endorsement by PRTS Wiki.

The PRTS-authored timeline material retains its CC BY-NC-SA 4.0 license; the independent plugin code remains under this repository's MIT License. Quoted game-original content retains its respective rights, as described above.

## Self-built Wiki: arknights_lore_wiki

Self-built Wiki data is sourced from [littlepangding/arknights_lore_wiki](https://github.com/littlepangding/arknights_lore_wiki). Its original material is covered by the [upstream MIT License](https://github.com/littlepangding/arknights_lore_wiki/blob/main/LICENSE), Copyright (c) 2025 littlepangding. Quoted game text and other third-party material retain their respective rights.

## Other third-party software and assets

Dependencies and other third-party components remain subject to their own licenses. Their inclusion or use does not change those licenses.

## Rhine Lab archive browser

The optional `rhine-lab` skin adapts the archive interaction and uses the original
`archive-cassette.glb` and `archive-assembly.glb` from [LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)
(source revision `e313777`). Its program code is MIT, Copyright (c) 2026 LBEILC;
the notice is preserved in `lib/rhine/licenses/RhineLabUI-MIT.txt`.
The upstream README explicitly excludes GLB models and original-work visual
materials from that MIT grant. `lib/rhine/assets/*.glb` retain
those upstream restrictions and the rights of the original rights holders.
This package does not relicense that model, the Rhine Lab identity, or game lore.
The packaged skin does not include upstream audio or PV footage. Four unmodified MiSans fonts
are included with their upstream copyright notice and license in `lib/rhine/fonts/NOTICE.txt`
and `lib/rhine/fonts/MiSans-license.pdf`. Rolling Number 0.4.1 retains its MIT license
in `lib/rhine/licenses/rolling-number-MIT.txt`.

The bundled Three.js runtime is MIT, Copyright © 2010–2026 three.js authors;
its license is preserved in `lib/rhine/licenses/three-MIT.txt`.

Research report formatting uses [markdown-it](https://github.com/markdown-it/markdown-it)
15.0.1 and its bundled dependencies. Their MIT and BSD notices are preserved in
`lib/rhine/licenses/markdown-it-MIT.txt`, `entities-BSD-2-Clause.txt`, `linkify-it-MIT.txt`,
`mdurl-MIT.txt`, `punycode.js-MIT.txt`, and `uc.micro-MIT.txt` in that directory.
