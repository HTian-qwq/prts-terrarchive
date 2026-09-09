# prts-terrarchive (English)

PRTS.chat corpus plugin for DeepSeek Harness (DSH). Provides local corpus
search, source reading and an activity-timeline tool, plus optional
PRTS.cloud hybrid retrieval. The plugin first obtains the approved current
release and per-file digests from the fixed `https://prts.chat` trust origin,
then downloads the local corpus from ModelScope or a configurable byte-only fallback;
the optional cloud service discovers candidates that can be mapped back to
local source text for verification. Anonymous cloud retrieval currently has an
allowance of 1,000 calls per user per day for DSH clients; this policy may
change as service capacity evolves.

- Zero npm dependencies; registers raw DSH `ToolDefinition`s.
- Host-resident instance (settings UI + data manager) + per-session "PRTS
  mode" preset that mounts the tools only for sessions that select it.
- The fixed `https://prts.chat` origin is the trust source for latest-release
  resolution and manifests; ModelScope and the configurable fallback only serve
  bytes for that fixed release and cannot select or attest a version.
- Two optional skins (PRTS Agent, Endfield AIC terminal) on top of the
  native Harness UI.

## Data sources

- **Self-built Wiki data**: sourced from [littlepangding/arknights_lore_wiki](https://github.com/littlepangding/arknights_lore_wiki).
- **Terra timeline data**: sourced from [PRTS Wiki's Terra timeline (泰拉年表)](https://prts.wiki/w/%E6%B3%B0%E6%8B%89%E5%B9%B4%E8%A1%A8) for the plugin's timeline search.

## Install

Web requires Node.js >= 22.19 and DSH >= 0.1.2-alpha.2. The current compatibility
target is DSH 0.1.5-alpha.1. An official Electron Desktop installation supplies
its own runtime. Corpus disk usage is shown in Settings before download.

### Available now: local Web installation

The npm release is being prepared and is not published yet. Install from a
local checkout, or use PRTS Portable with the plugin already included:

```bash
npm install --global @deepseek-ai/dsh@0.1.5-alpha.1
git clone https://github.com/HTian-qwq/prts-terrarchive.git
cd prts-terrarchive
node bin/install.js web
```

The local installer adds the package to the selected profile and creates or
migrates the compatibility preset in `$DSH_HOME/.agent-presets/prts`. With no
second argument it uses its own checkout. Another local directory or archive
can be supplied explicitly:

```bash
node bin/install.js web /path/to/prts-terrarchive
```

### After npm publication: Web

Once published, install the bundle directly; no additional installer command
or npm lifecycle hook is needed:

```bash
dsh plugin --profile web add prts-terrarchive@0.1.0
```

Restart `dsh web`. The plugin seeds "PRTS 模式" (PRTS mode) into the Host's user
preset directory, normally `$DSH_HOME/.agent-presets/prts`, where DSH discovers
it automatically. This happens at plugin activation, without `postinstall`.
The default mode, configured roots, and running sessions stay intact. Existing
unmarked presets and user-edited presets are preserved. Only unchanged templates
carrying the plugin's content marker are updated when the plugin is upgraded.
Disabling or uninstalling the plugin leaves these user files in place; remove
PRTS mode through DSH's preset manager when no longer needed.

```bash
dsh plugin --profile web remove prts-terrarchive
```

### Official Electron Desktop

The official repository contains an Electron implementation. The public
product page currently documents npm Web and source launches; we have not
confirmed a publicly released official desktop installer. This integration
prepares for that implementation, and the plugin's npm release is still pending.

After obtaining a compatible Desktop build and after npm publication, enter
`prts-terrarchive@0.1.0` in the **desktop application's plugin manager**.
The manager accepts npm registry package names and versions, not GitHub URLs,
local directories, or tarballs. Electron exclusively manages the `desktop`
profile: do not run `node bin/install.js desktop` or
`dsh plugin --profile desktop`.

Web and official Desktop share the default `$DSH_HOME` product data while
installing their plugins separately. The plugin package includes its UI,
map models, textures, skills, and presets. It does **not** bundle corpus data,
Node/DSH runtimes, or user data. Open Settings → Plugins → PRTS 语料 and download
the corpus explicitly before using local retrieval. Switching skins does not
start a separate model or texture download.

PRTS Portable distributions include the plugin, presets, and the complete corpus,
so no separate corpus download is needed after extraction. Build the official
Electron portable target with `build-electron.ps1`; the original WebView2 build
entry remains available. See the [Portable repository](https://github.com/HTian-qwq/prts-terrarchive-portable).

Portable builders that already placed the plugin can continue running
`node bin/install.js web --preset-only` to create or migrate the compatibility
preset without invoking the DSH CLI.

### Windows

Local Web installation requires `dsh.cmd`. The installer invokes it through
cmd.exe, so plugin paths containing a line break or `%` `!` `&` `|` `<` `>` `^`
`"` are rejected. Use a directory without these characters. The `DSH`
environment variable can locate an absolute `dsh.cmd` path. Official DSH stores
the corpus under `%USERPROFILE%\.dsh\prts-corpus\releases` by default;
Portable stores sessions and settings in its own `userdata` directory, and the
bundled corpus and subsequent corpus updates in `corpus/releases`.

### Retrieval settings

Select PRTS mode in new sessions to load the corpus tools, DSH's native
`web_search` and `web_fetch`, and the retrieval Skill. The preset enables both
`arknights` and `endfield`; Settings stores the effective modules as
`enabledGames` in `$DSH_HOME/prts-corpus.json`. Start a new session after changing
them. The preset enables anonymous cloud retrieval by default. A raw plugin
instance without the cloud configuration keeps it disabled.

Static tokens are bound to the saved service origin. Changing the URL cannot
forward a token to another origin. Re-enter legacy tokens that lack an origin
binding in Settings; they remain unsent until saved again.

After the retrieval Skill loads, matched entities and relationships enter DSH's
dynamic context for the current question. Each new snapshot supersedes the
previous one. Tool titles identify local/cloud retrieval and the game scope.

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
  activity timeline must be fetched explicitly, e.g. via `timeline_search`).
  In a dual-module session, add `game: "arknights"` or `game: "endfield"` only
  when a character locator needs same-name disambiguation.
  Use exactly one primary locator per call. If search returns `document_uid`, it
  replaces `title`; use `{document_uid, line}` or
  `{document_uid, mode:"document"}`, never both locators. `max_lines` and
  `max_chars` only cap output and do not select a read mode
- `timeline_search` — query the Terra calendar timeline; source markers can
  be resolved back to full provenance
- `cloud_search` / `cloud_inspect` — optional PRTS.cloud hybrid retrieval
  (enabled via settings; results are mapped back to local documents)
- `web_search` — native DSH web discovery for external history, etymology,
  folklore, and other non-PRTS sources
- `web_fetch` — read a known public URL for close reading and cross-checking

Repeated and partially reused reads retain the normal page limits and
continuation. Partial reads include `coverage` identifying previously visible
lines and newly returned lines; `page.has_more` still determines whether the
document has more content. Cloud answers remain available when local corpus
mapping fails, with a warning to install or repair the corpus before verifying
the original text.

If the corpus changes during a read or search, the request returns a retryable
`PACKAGE_VERSION_MISMATCH`; resolve the locator against the current version
before retrying. Old operations cannot populate the new version's document or
search caches. Reused reads and reads spanning multiple documents enforce the
same version check.

Wiki documents are typed as canonical character pages, story/operator-record
pages, or character-by-activity auxiliary pages. `corpus_search.wiki_sections`
combines those types with character/activity filters, while
`corpus_read({title, section})` reads the exact tagged field. See
`skills/prts-retrieval/references/wiki-schema.md` and `retrieval-recipes.md`
for field semantics and query recipes.

## Compatibility

DSH 0.1.2-alpha.1 and 0.1.2-alpha.2 have completed historical real-host tests
with the web profile. Alpha.1 was built from the official tag and passed
installation, preset resolution, host startup, settings-route, and
client-bundle checks. The current compatibility target is DSH 0.1.5-alpha.1.
The shared Connection Fetch transport supports Web and the official Electron
source implementation; Web also retains HTTP routes. Preset seeding has passed
real source Loader tests on both 0.1.5-alpha.1 and 0.1.3-alpha.1, covering cold
startup, activation, disable, uninstall, and uninterrupted ordinary-session
mounts. Windows Electron has not been tested end to end on a real installation.
The Electron portable builder pins the official 0.1.5-alpha.1 tag; the original
WebView2 builder still pins 0.1.3-alpha.1. Both require a static audit plus a
real Host smoke test before release.

Custom deployments with `includeUserRoot: false` and no other preset root with
`trust: user` receive no generated preset or root changes; their operator must
first enable user preset authoring. The plugin relies on internal host surfaces
(`ctx.tools`, `agent/pre-step`, Connection Fetch, agent presets, client
slots/theme); after a DSH major upgrade, re-run the smoke checklist below.

## Development

`presets/` contains the PRTS composition, metadata, and user-preset initializer.

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
- **Corpus datasets:** full datasets are not distributed in this Git repository
  or bundled plugin code. Downloaded PRTS.chat datasets remain subject to the
  licenses, source declarations, and terms on the
  [Arknights dataset](https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-arknights)
  and [Endfield dataset](https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-endfield)
  pages.

This is an unofficial community project and is not affiliated with or endorsed by the games' developers or publishers. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the complete notice.
