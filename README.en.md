# prts-terrarchive (English)

PRTS.chat corpus plugin for DeepSeek Harness (DSH). Provides local corpus
search, source reading and an activity-timeline tool, plus optional
PRTS.cloud hybrid retrieval. The plugin first obtains the approved current
release and per-file digests from the fixed `https://prts.chat` trust origin,
then downloads the local corpus from ModelScope or a configurable byte-only fallback;
the optional cloud service discovers candidates that can be mapped back to
local source text for verification. Anonymous cloud retrieval currently has a
cumulative allowance of 1,000 calls per DSH instance; this policy may change
as service capacity evolves.

- Zero npm dependencies; registers raw DSH `ToolDefinition`s.
- Host-resident instance (settings UI + data manager) + per-session "PRTS
  mode" preset that mounts the tools only for sessions that select it.
- The fixed `https://prts.chat` origin is the trust source for latest-release
  resolution and manifests; ModelScope and the configurable fallback only serve
  bytes for that fixed release and cannot select or attest a version.
- Two optional skins (PRTS Agent, Endfield AIC terminal) on top of the
  native Harness UI.

## Install

Requires Node.js >= 22.19 and a DSH runtime >= 0.1.2-alpha.1. Alpha.1 works
when bundled by a desktop distribution or built from the official tag, but it
was not published to npm; use 0.1.2-alpha.2 or newer when installing DSH from npm.

This plugin is not published to the npm registry. End users should prefer a
PRTS/DSH portable distribution that already bundles it. Developers with DSH
installed can add it directly from a local source checkout:

```bash
npm install --global @deepseek-ai/dsh@0.1.2-alpha.2
git clone https://github.com/HTian-qwq/prts-terrarchive.git
cd prts-terrarchive
node bin/install.js web
```

The installer adds the plugin to the profile and creates the "PRTS 模式"
(PRTS mode) preset under `$DSH_HOME/.agent-presets/prts`. With no second
positional argument, it always adds its own local plugin directory and never
resolves this plugin through the npm registry. You may instead pass another
existing local directory or archive explicitly. After restarting DSH, open
Settings → Plugins → PRTS 语料 to pick a skin and download the
corpus. Endfield AIC skin code, models, and textures are included in the
plugin package; switching to that skin does not start another download. Then
select PRTS mode in new sessions to load the corpus tools plus DSH's native
`web_search` and `web_fetch` tools. Search discovers candidate pages; fetch
reads a known public URL for close verification. DSH's anonymous HTTP provider
validates DNS answers, pins connections to public addresses, allows only
same-origin redirects, and enforces response and timeout limits.

The generated preset enables both `arknights` and `endfield`. The effective
module list is stored as `enabledGames` in `$DSH_HOME/prts-corpus.json`; use a
single item for a single-game setup and start a new session after changing it
so the matching Skill module is assembled. A dual-module session is admitted
only when the active local release contains both official game packs.

For example, to install another local checkout:

```bash
node bin/install.js web /path/to/prts-terrarchive
```

To remove the plugin, use DSH directly:

```bash
dsh plugin --profile web remove prts-terrarchive
```

### anywhere-labs DSH Desktop

Use a portable/DSH Desktop distribution that already bundles the plugin. To
install a local source checkout into its `desktop` profile manually, open the
dedicated terminal from the DSH Desktop tray and run:

```bash
node bin/install.js desktop
```

Restart DSH Desktop after installation. Compatibility mode is the recommended
starting point. A distribution that has already placed the package in its
profile can run `node bin/install.js desktop --preset-only` to create or
migrate only the PRTS mode preset.

### Windows

The core plugin (local corpus tools, settings UI, dataset download) is pure
Node and works on Windows directly:

1. Install Node.js >= 22.19 and the npm-published `@deepseek-ai/dsh@0.1.2-alpha.2`
   or newer
   (`npm i -g`, then make sure `dsh.cmd` is on PATH);
2. Obtain this plugin's source, open its root directory, and run
   `node bin/install.js web`. The installer invokes `dsh.cmd` through cmd.exe;
   paths containing `%` `&` `|` `<` `>` `^` `"` are rejected with a
   clear error — put the project in a directory without those characters
   (or point the `DSH` env var at the absolute path of `dsh.cmd`);
3. `dsh web` → Settings → Plugins → PRTS 语料 → download the corpus
   (~322 MiB, ModelScope mirror first);
4. Pick "PRTS 模式" in new sessions. The corpus lives under
   `%USERPROFILE%\.dsh\prts-corpus\releases` by default.

## Skins and assets

- **Harness default** keeps the native DSH interface.
- **PRTS Agent** provides the PRTS.chat terminal-style interface.
- **Endfield AIC** provides an optional Arknights: Endfield-inspired terminal
  and 3D map. Its runtime code, models, and textures are pre-compressed and
  installed with the plugin; switching skins does not start another download.

The two optional skins have separate stylesheets. The client keeps only the
active skin stylesheet mounted, plus a small shared stylesheet for plugin
controls, so neither optional skin depends on the other's CSS.

The Endfield AIC plugin code, UI integration, and map-rendering implementation
are licensed under the MIT License. Game-derived models and textures used by
that skin are not covered by the MIT License and are packaged only as parts of
the optional skin. See [GAME_ASSETS.md](GAME_ASSETS.md) for the exact paths.
These assets are independent of corpus version management: corpus datasets are
downloaded from a verified ModelScope mirror or PRTS.chat on request, while skin assets require no separate
download.

## Tools

- `corpus_search` — grep-style search over the local corpus: literal or a
  linear regex subset (anchors, dot, character classes, escapes and fixed
  `{n}` repetitions; no grouping, alternation or variable quantifiers) on NFKC-normalized text, with resource-type /
  character / story / activity / entity / speaker / Wiki-field filters;
  keep the original conditions and pass `page.next_after` back unchanged as
  `after` to continue, because the readable anchor includes the full
  `data_version` and becomes invalid after a corpus release switch
- `corpus_read` — read Arknights stages by `stage_code` (adding `story_part`
  only when needed), operator records by character/name/segment, and character
  materials by category; it can stream a whole Arknights activity or Endfield
  mission collection with readable, version-bound continuation positions;
  it can also read a tagged Wiki field or page through a whole document; story
  documents return requested text only (self-built summaries and the
  activity timeline must be fetched explicitly, e.g. via `timeline_search`)
- `timeline_search` — query the Terra calendar timeline; source markers can
  be resolved back to full provenance
- `cloud_search` / `cloud_inspect` — optional PRTS.cloud hybrid retrieval
  (enabled via settings; results are mapped back to local documents)
- `web_search` — native DSH web discovery for external history, etymology,
  folklore, and other non-PRTS sources
- `web_fetch` — read a known public URL for close reading and cross-checking

Wiki documents are typed as canonical character pages, story/operator-record
pages, or character-by-activity auxiliary pages. `corpus_search.wiki_sections`
combines those types with character/activity filters, while
`corpus_read(mode="section")` reads the exact tagged field. See
`skills/prts-retrieval/references/wiki-schema.md` and `retrieval-recipes.md`
for field semantics and query recipes.

## Compatibility

Tested against DSH 0.1.2-alpha.1 and 0.1.2-alpha.2 (web profile). Alpha.1 was
built from the official tag and passed installation, preset resolution, host
startup, settings-route, and client-bundle checks. The safe anonymous HTTP
fetch provider is available from alpha.1. The plugin
relies on internal host surfaces (`ctx.tools`, `agent/pre-step`, host
Connection RPC, webServer routes, agent presets, client slots/theme); after
a DSH major upgrade, re-run the smoke checklist below.

## Development

```bash
npm run check   # syntax check
npm test        # node --test suite
git diff --check
```

`bin/pack-map-assets.mjs` pre-compresses the Endfield map assets
(brotli q9 + gzip 9, the same scheme as endfield.prts.chat); the bundled
plugin only carries compressed variants. `npm run pack:map:restore`
restores plaintext for development.

## License

This project uses the following licensing boundaries:

- **Original code and documentation:** licensed under the [MIT License](LICENSE).
- **Game-related content:** names, trademarks, images, models, textures, game data, and other materials relating to Arknights or Arknights: Endfield are not covered by the MIT License and belong to their respective rights holders. See [GAME_ASSETS.md](GAME_ASSETS.md) for the exact packaged paths.
- **Corpus datasets:** full datasets are not distributed in this Git repository or bundled plugin code. Datasets downloaded from ModelScope or PRTS.chat remain subject to the licenses, source declarations, and terms on their corresponding dataset pages.

This is an unofficial community project and is not affiliated with or endorsed by the games' developers or publishers. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the complete notice.
