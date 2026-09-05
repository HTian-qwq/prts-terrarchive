# prts-terrarchive (English)

PRTS.chat corpus plugin for DeepSeek Harness (DSH). Provides local corpus
search, source reading and an activity-timeline tool, plus optional
PRTS.cloud hybrid retrieval. Users download the local corpus from ModelScope;
the optional cloud service discovers candidates that can be mapped back to
local source text for verification. Anonymous cloud retrieval currently has a
cumulative allowance of 1,000 calls per DSH instance; this policy may change
as service capacity evolves.

- Zero npm dependencies; registers raw DSH `ToolDefinition`s.
- Host-resident instance (settings UI + data manager) + per-session "PRTS
  mode" preset that mounts the tools only for sessions that select it.
- Dataset downloads prefer the ModelScope mirror end-to-end (including
  latest-release resolution); the PRTS.chat site is only a fallback.
- Two optional skins (PRTS Agent, Endfield AIC terminal) on top of the
  native Harness UI.

## Install

Requires Node.js >= 22.19 and a DSH runtime >= 0.1.2-alpha.1. Alpha.1 works
when bundled by a desktop distribution or built from the official tag, but it
was not published to npm; use 0.1.2-alpha.2 or newer for the npm command below.

```bash
npm install --global @deepseek-ai/dsh@0.1.2-alpha.2
npx --yes prts-terrarchive@next web
```

The installer adds the plugin to the profile and creates the "PRTS 模式"
(PRTS mode) preset under `$DSH_HOME/.agent-presets/prts`. When launched by
`npx`, it adds the same exact package version that is running, preventing a
different release from being selected during installation. After restarting
DSH, open Settings → Plugins → PRTS 语料 to pick a skin and download the
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

For development from a source checkout:

```bash
node bin/install.js web .
```

### anywhere-labs DSH Desktop

Open the dedicated terminal from the DSH Desktop tray and target its
`desktop` profile explicitly:

```bash
npx --yes prts-terrarchive@next desktop
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
2. Run `npx --yes prts-terrarchive@next web`. The installer invokes `dsh.cmd` through
   cmd.exe; paths containing `%` `&` `|` `<` `>` `^` `"` are rejected with a
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
downloaded from ModelScope on request, while skin assets require no separate
download.

## Tools

- `corpus_search` — grep-style search over the local corpus: literal or
  bounded-regex matching on NFKC-normalized text, with resource-type /
  character / story / activity / entity / speaker / Wiki-field filters
- `corpus_read` — read exact source lines and continue by natural title + official line; opaque cursors are legacy-only
  number, read a tagged Wiki field, or page through a whole document; story
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
npm pack --dry-run
```

`bin/pack-map-assets.mjs` pre-compresses the Endfield map assets
(brotli q9 + gzip 9, the same scheme as endfield.prts.chat); the shipped
package only carries compressed variants. `npm run pack:map:restore`
restores plaintext for development.

## License

This project uses the following licensing boundaries:

- **Original code and documentation:** licensed under the [MIT License](LICENSE).
- **Game-related content:** names, trademarks, images, models, textures, game data, and other materials relating to Arknights or Arknights: Endfield are not covered by the MIT License and belong to their respective rights holders. See [GAME_ASSETS.md](GAME_ASSETS.md) for the exact packaged paths.
- **Corpus datasets:** full datasets are not distributed in this Git repository or npm package. Datasets downloaded from ModelScope remain subject to the licenses, source declarations, and terms on their corresponding dataset pages.

This is an unofficial community project and is not affiliated with or endorsed by the games' developers or publishers. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the complete notice.
