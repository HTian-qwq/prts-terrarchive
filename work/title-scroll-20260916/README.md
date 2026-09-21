# Continuous investigation titles

Changed the report entry title and the selected archive title to a slow, seamless leftward text loop. The text moves without hovering; the button area and adjacent arrow remain in place.

## Implementation

- `ui/rhine/looping-title.ts` maintains one accessible label and a pair of visual copies. Equal-width copies and a 50% translation make the loop seamless.
- The duration follows the rendered text width at 16 stage pixels per second (at least 10 seconds per cycle).
- Repeated status snapshots preserve the current loop. Changed labels begin a new loop.
- Empty source prompts stay static. Reduced motion displays a static title, ellipsizing long text while retaining the complete accessible label and tooltip.
- Resize observers are disconnected when the workbench is disposed.
- `workbench.ts`, `workbench.css`, and `original-ui.css` wire the two titles; other rolling controls retain their existing behavior.

## Validation

- TypeScript compilation passed.
- Vite production build passed. Existing runtime font URLs remain unchanged.
- `browser-report.json`: normal-motion movement, loop boundaries, repeated updates, single accessible names, real report/source opening, long titles at 390px, reduced-motion switching, disposal; no JavaScript errors. The DOM probe disables WebGL to isolate the title effect from software rendering cost.
- `visual-report.json`: actual 3D scene loaded at 1743×939, both titles animated continuously, no JavaScript errors; the isolated probe paused rendered frames only for the screenshot. Validation screenshots are no longer archived.
- `dsh-assets.json`: the running local DSH on port 18915 serves both final bundles byte-for-byte. Existing browser tabs can refresh to load the updated UI.

`before/` contains snapshots of the pre-existing files touched by this change. No corpus data or DSH conversation was changed by these UI checks.
