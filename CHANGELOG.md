# Changelog

All notable changes to **Multi Stitch Images**. The version is the one in `pyproject.toml`; each release is tagged `v<version>` on `main`.

## 1.2.4 — 2026-09-13

### Changed
- **The `×` is back on every image card.** Clearing the cards in 1.2.0 took removing with it, and reaching for the right-click menu every time turned the most frequent thing you do to a card into the slowest. It sits in the same corner as the video card's, and is answered before the card is picked up, so pressing it never becomes a drag. The other buttons stay gone — duplicating, copying, replacing and reordering are still the menu and the drag. `Remove image #N` remains on the menu as well, and the step is undoable either way.

## 1.2.3 — 2026-09-13

### Fixed
- **Loading a composition from the gallery now counts as using it.** The 200-entry cap drops the least recently used entry, but "used" was only written when a composition was *stitched* — so an entry someone reached for often and loaded back into a node, without ever running it again, kept ageing and could be evicted while untouched ones stayed. `Load` and `Add` mark the entry as used through a new `/multi_stitch/gallery/touch` route, which moves it to the front of the list. A server that cannot record the visit is logged and ignored: the composition is already in the node by then, so it must not turn into an error.

## 1.2.2 — 2026-09-13

### Fixed
- **Three shipped descriptions still promised the `≡` handle** that 1.2.0 removed — the node's own `DESCRIPTION` (which ComfyUI shows on hover and the registry shows on the node's page), the Korean locale, and the note inside the `paste → strip` example workflow. All three now describe the gestures the node actually has.
- **The card menu in Vue node mode was missing `Replace image…`**, which the canvas card menu has had all along. Both menus now offer the same five entries.

### Changed
- **A card says what it answers to while the pointer is on it.** Taking the buttons off the cards took the visible affordances with them, and the hint that explains them only ever appeared in the empty dashed box — so it vanished the moment a first image arrived. While the pointer is over a card the status line reads `Click to edit · drag to reorder · right-click for more`, and the cursor stops pretending the card is empty canvas. Both give way again the moment the pointer moves off, and the canvas keeps the cursor the frontend gave it.
- **Columns follow the node's width instead of always being three.** A node made wider used to stretch three cards into 390×92 letterboxes while showing exactly as many images as before; it now fits as many ~130px cards as the width allows (8 at 1200px), so widening shows more images and the list gets shorter — 6 images at 1200px are one row instead of two.

## 1.2.1 — 2026-09-13

### Changed
- **A card's right-click menu is the card's own**, not five more lines on the node's. The node menu is long and is about the node — bypass, colors, clone, remove — and the per-image entries sat on top of it, so a menu opened over a picture was mostly about something else. Right-clicking a card now opens a short menu titled `Image #N` holding only `Edit`, `Duplicate`, `Copy to clipboard`, `Replace` and `Remove`; a video card gets its own two entries the same way. The node's menu keeps what is about the node as a whole: `Copy stitched result`, the size panel and the gallery. Right-clicking anywhere else on the node — the title, the widgets, the empty space — still opens the node's menu unchanged, as does right-clicking any other node. Where the frontend does not offer the pieces this needs, the entries fall back onto the node's menu exactly as before.

## 1.2.0 — 2026-09-13

### Added
- **Gallery of compositions** (`🖼` in the title bar, left of the `?`): every composition a run stitches — the image list with its crops, order and settings — is recorded with a preview, and any of them can be loaded back into a node or appended to it. Entries are named, renamable, deduplicated (the same composition twice is one entry with a use count) and capped at 200, the least recently used dropped first. `Save current` records without running, and `save every run` can be turned off; the setting lives with the gallery on the server, not in a node widget, so no saved workflow shifts.
- **Storage clean-up**: the gallery header says how much `input/multi_stitch` holds and how much of it no entry references, and offers to delete exactly that. Deleting an entry keeps its files unless asked; deleting files never touches one that another entry, or a node open in the browser, still uses. Both steps confirm first and say what cannot be detected (a workflow saved on disk).
- **Vue "Nodes 2.0" support**: in that mode the node body is a Vue component, so nothing canvas-drawn appeared — the status line, toolbar, preview band, thumbnails and size panel were simply missing. They are now also rendered as a DOM widget, reading the same state and calling the same actions as the canvas, so both modes behave alike.
- **Toolbar row** under the status line: `+ Add · Clear · ⧉ Copy · ↶ ↷ · Preview · Options`. The `Add images…` and `Clear all` button widgets are gone; `+ Add` reads `Cancel k/N` while an upload runs, and the empty dashed box opens the file picker too.
- **Folded advanced options**: `output_limit`, `output_limit_px`, `grid_cell_width`, `grid_cell_height`, `output_cells`, `cells_resolution` and `minimum_image_side` appear only after `Options ▸`. A non-default value stays visible while folded and is counted on the pill (`Options ▸ (2)`); the fold state is saved with the workflow.
- **Copy stitched result** (`⧉ Copy`, or the node's context menu): renders the composite in the browser from the original files at the final size and puts it on the clipboard as PNG. Capped at 64 MP; frames from the IMAGE input are not included; an image that failed to load is left as background, and the notice says so.
- **`match_reference`** (`first` / `largest` / `smallest`): which image `match_image_size` matches the others to. `largest` and `smallest` go by the shared side in a strip and by area in a grid, the reference keeps its own size, and a tie goes to the earlier image. The widget lives under `Options ▸` while matching is on and sits last in the definition, so saved workflows keep their widget slots; a slot an older workflow left empty is reset to the default on load instead of failing validation.
- **Sharp preview**: when the canvas zoom or a HiDPI screen would stretch the 512px thumbnails, the preview band is redrawn from the original files at the size it needs (bounded to 2048px / 4 MP, one cached bitmap per node, re-rendered after a short delay when the layout, the images or the needed size change). Thumbnails, the preview and the copied result now reduce images by halving in steps with high-quality smoothing, so a 4000px source no longer aliases on the way down.
- **Frames from a video**: `+ Add` or a drop accepts a video, which opens a frame picker (play, scrubber, frame steps with `requestVideoFrameCallback` and fps detection, keyboard shortcuts). Each capture uploads the frame on screen as a native-resolution PNG and adds it as an ordinary image, tagged with its source time. The video itself is uploaded only to ComfyUI's temp folder, never saved with the workflow or stitched, and is deleted from the server through a new `/multi_stitch/video/delete` route on the picker's Done, the card's ×, Clear, node removal or leaving the page; ComfyUI's temp cleanup on start-up catches the rest.
- **Server decoding for videos (PyAV)**: three routes — `/multi_stitch/video/info`, `/multi_stitch/video/frame` (JPEG preview at a time) and `/multi_stitch/video/capture` (the decoded frame saved as a PNG in the input folder). The picker switches to server mode when the browser cannot play the file (the card's poster comes from the server too), and a "server capture" checkbox gives a decoder-exact frame for playable videos. Decoding runs off the server's event loop; PyAV missing is reported, not fatal.
- **`width` / `height` outputs and the size panel**: the reference image's size (`size_reference`: the image's number in the list, 1 = the first), rescaled to `size_megapixels` and snapped to `size_divisible_by` (default 32), for an Empty Latent or a resize node. A `📐 Size` button in the title bar (and the context menu) adds a panel under the node showing a box of that aspect with a readout such as `672 x 1184 | 9:16 | 0.80 MP | divisible by 32`; the three widgets appear only while the panel is on, and the state is saved with the workflow. `referenceSize` mirrors `_reference_size`, checked by the parity test.
- **Duplicate an image** (`Duplicate image #N` on a card's right-click menu): the same file once more, right after the one it came from, with its own crop and transform. Nothing is uploaded again, and the step is undoable.
- **Tooltips** on every widget and on both outputs.
- **Korean UI** (`locales/ko/nodeDefs.json`): widget names, option labels, tooltips and the node description in ComfyUI's Korean locale.
- **Example workflows** (`example_workflows/`, shown in ComfyUI's template browser): paste → strip, and a three-image batch → two-column grid with the `cells` output.
- **Registry publishing** workflow (`.github/workflows/publish_action.yml`): runs when `pyproject.toml` changes on `main`, and skips with a notice until a `REGISTRY_ACCESS_TOKEN` secret exists.

### Fixed
- **The gallery evicted the wrong entry** when several compositions were recorded inside one clock step: `time.time()` advances in ~16 ms steps on Windows, so their "used" stamps tied and "least recently used" fell back to whatever order the folder listed. A stamp is now always strictly after the newest one, and the id breaks any tie left by an older entry, so both the eviction and the gallery's own ordering follow the order things were actually used.
- **High bit-depth sources no longer come out white**: a 16-bit grey PNG or TIFF (`I;16`, `I`) and a float image are scaled by their own range instead of being clipped by `convert("RGB")`.
- **EXIF-rotated TIFFs on Pillow 10.x**: the measured and decoded sizes disagreed there, aborting the stitch with "the file changed while stitching". The turn is now decided from the stored tags, so every Pillow from 10.0 works.
- **Peak memory and wasted work in the decode**: the crop is mapped back to source coordinates and taken first, the transforms run on the crop, and the float conversion is in place. A 25 MP source costs roughly a third less.
- **Three routes answered 500** where they should have explained themselves: `max_side=inf`, a directory named like a video in the temp folder, and any other `OSError` during a delete or a decode.
- **A missing file or a corrupt list is reported when the workflow is queued**, through `VALIDATE_INPUTS`, instead of part-way through a run, and the message names the image rather than the server's absolute path.
- **A symlinked subfolder inside `input/` works**, as it does for ComfyUI's own loaders; the path check is lexical now and still refuses `..`, absolute paths, drive letters and NUL.
- `cells_resolution = placed` now honours `output_limit`, as its tooltip always said.
- **ComfyUI's own undo no longer throws away a pending video** or the node's edit history: a removal that is really a graph reload is recognised, and the same node gets its session back.
- **The frame picker and the crop editor swallow the keys they handle**, so Delete no longer removes the node underneath and Space no longer pans the canvas behind the dialog.
- Removing or relinking one image keeps the other thumbnails; a progress suffix can no longer stick to the node's title; the `Cancel 100/256` pill and the video card's caption stay inside their boxes; a card says whether a file timed out (with a retry) or simply cannot be previewed in a browser; the clipboard message distinguishes a missing API from an insecure page, and a second `⧉ Copy` click writes the cached rendering at once.
- The sharp preview decodes originals at the size it needs, one at a time across all nodes, and refuses a canvas the browser will not allocate with a message instead of a blank band.

### Changed
- `match_image_size` defaults to `true` and `match_reference` to `smallest` for new nodes, so images line up by height (or width) from the start without anything being upscaled; `output_limit` stays `none`. Saved workflows keep their own values; one saved before `match_reference` existed opens with `first`, as it behaved then, and an API prompt that omits the value gets `first` too.
- A fresh node shows five widgets (`direction`, `match_image_size`, `spacing_width`, `spacing_color`, `layout_mode`) instead of ten rows.
- The status line uses the full node width; the controls moved to the toolbar.
- **Nothing is drawn over a card's picture any more.** The `⧉` duplicate, `×` remove, `‹ ›` steps and the `≡` handle are gone, and with them the blue capture-time badge that pushed the buttons off a narrow card; a card shows its number and its crop / rotation marks. **Click to edit, drag the card itself to reorder, right-click for the rest** — `Edit`, `Duplicate`, `Copy to clipboard`, `Replace` and `Remove`, each naming the card it acts on. `Copy image #N to clipboard` is the clipboard copy (Ctrl+V pastes it back, or into another program); `Duplicate image #N` is the one that adds another card here. The Vue node mode's card menu offers the clipboard copy too, which it had been missing. A video card keeps its `×`, since a click on it opens the frame picker.
- While a card is dragged, the slot it would drop into is drawn as a **blue bar between the cards** rather than outlining whichever card is nearest, so the landing place is unambiguous at the ends of a row. Releasing without passing the drag threshold is still a click, and opens the editor.
- The thumbnail list no longer scrolls: the node grows downward so every row is visible (the fixed-height list from 1.0 is gone; only the width is resizable).
- The empty dashed box spans the list width instead of one grid cell, so its hint fits inside it and the whole width is a click target. Explanatory text that is still wider than its box (that hint, the size panel's) wraps at a word instead of running past the edge, and the readouts (status line, preview caption, size panel) are bounded to their width.

### Tests
- The logic suite follows the new geometry and adds a toolbar/folded-options suite; the browser suite's card coordinate follows.
- `tests/test_packaging.py` checks that every input and output has a tooltip, that the Korean locale covers the node definition exactly, that the example workflows match `INPUT_TYPES` (widget count, order and value ranges, link consistency), and that the version, changelog and README agree.

## 1.1.0 — 2026-09-10

- New nodes keep **native size** by default: `match_image_size = false`, `output_limit = none`. Saved workflows keep their own settings.
- `cells_resolution = source` gives the individual images at their original size, unscaled.
- `minimum_image_side` stops execution before decoding when any placed image's short side would fall below the value.
- A referenced file that changes on disk (size or modification time) makes the node re-execute.
- At most two thumbnail decodes run at once; a PNG whose EXIF sits after the pixel data is still read without decoding; TIFF orientation is respected; a malformed EXIF chunk degrades to "no orientation" instead of an error.
- Every IMAGE-input frame is size-checked and converted lazily, one at a time.

## 1.0.0 — 2026-09-06

The first tagged version, and the work that followed it before 1.1:

- Paste many images into one node (Ctrl+V, drop, file picker), stored under `input/multi_stitch/`; up to 256 per node.
- Per-image crop editor with edge and corner handles, 90° rotation and flips; a dedicated `≡` drag handle for reordering, separate from the edit click.
- Strip and grid layouts, spacing width and colour including a custom hex colour.
- Header-only measurement before decoding (EXIF orientation included), streaming composition one source at a time, output and per-source pixel guards.
- Composite preview band, output size limits and fixed grid cells, an optional IMAGE input and a per-image `cells` output, undo/redo, a fixed-height scrollable list, relinking a missing file, and copying an original image from a thumbnail's context menu.
- Backend, logic and Playwright browser test suites on GitHub Actions.
