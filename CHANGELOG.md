# Changelog

All notable changes to **Multi Stitch Images**. The version is the one in `pyproject.toml`; each release is tagged `v<version>` on `main`.

## 1.9.0 — 2026-09-15

### Added
- **The editor walks the list.** `‹` and `›` beside Cancel and Apply — or the **arrow keys** — keep the edit and move to the next image without closing the panel. Editing several cards was `Apply → the editor closes → find the next card → click → wait for it to load → edit`, and most of that was the closing and the finding. The whole panel stays put; only the picture in it changes.
- **Walking past an image costs nothing.** The step commits only when something was actually changed, so browsing the list adds no undo steps and touches no card. The header counts where you are (`Edit image 2 of 5`) and the arrows stop at either end rather than wrapping.
- Each image is still its own undo step, and a second press while a picture is still loading cannot leave the slower load to land last.

### Fixed
- The brush row showed while the crop tool was out: an author rule that sets `display` outranks the browser's own `[hidden]` rule whatever its specificity, so hiding it by attribute did nothing.

## 1.8.0 — 2026-09-15

### Added
- **A blur brush in the image editor.** `◍ Blur` switches the editor from cropping to painting: drag to blur a face, a licence plate, a watermark, anything that should be in the picture without being readable. **Brush** sets the width and **Blur** the strength, both in the picture's own pixels; the ring under the pointer is the brush at its real size. `Ctrl+Z` (or `↶ Stroke`) takes back the last stroke and `Clear blur` removes them all.
- **The strokes are stored, not burnt in.** Like the crop and the rotation, an item carries its strokes as numbers — fractions of the transformed picture, with radii against its longest side — so the source file is never touched, the editor reopens on what you painted, a quarter turn carries the strokes round with the picture, and a gallery entry brings them back. The cards, the in-node preview and `⧉ Copy` all show them.
- The blur runs on the tensor rather than through Pillow's filters, which refuse the 16-bit and float modes the high-depth path exists to keep intact — painting a stroke on such a file would otherwise have thrown its depth away. It is a separable Gaussian, and a wide one is taken on a reduced copy so a strong blur on a large picture costs the same as a weak one. The mask is feathered by a fraction of the blur so the edge does not read as pasted on, and strokes are painted after the crop, so only the pixels that survive it are ever touched.
- Numbers arriving from a workflow are checked rather than trusted: strokes, points, radii and strength are all bounded, and anything that is not a real number is dropped on both sides — `Number(null)` is `0` in JavaScript, which would have turned a broken coordinate into a real one.

## 1.7.1 — 2026-09-14

### Fixed
- **Copying from the editor gave you the editor, not the picture.** A right-click there fell through to the browser's own menu, whose "Copy image" hands over the `<canvas>` exactly as drawn — darkened surround, white crop outline, thirds grid and handle bars baked into the pixels. The editor answers the right-click itself now, with **`Copy crop to clipboard`** (the crop at its own full resolution, rotation and flip applied, cut with the same box the server uses) and **`Copy whole image to clipboard`**. A browser test copies at full frame and compares every sample against the source file, so a single pixel of overlay fails it.
- A right-click beside the panel no longer asks whether to discard the edit, and Escape with the menu open closes the menu rather than the editor.

## 1.7.0 — 2026-09-14

### Added
- **Every image says what it measures.** A card carries its pixel size in its **bottom-right corner**, at half the card's type size so it reads as a note on the picture rather than a label over it, and a cropped card carries the size the crop leaves — in the amber its ✂ badge already uses, so a number that is no longer the file's own size looks like it. Hovering a card puts both on the status line (`3000 × 2000 → 1400 × 2000`), and the Vue view carries the same pair in the card's tooltip.
- **The editor counts the crop while it is dragged.** Its header was showing the source size and nothing else, so the size a crop produced could only be found out after applying it. It now reads `1080 × 1920 → 792 × 1411` and updates on every move of the rectangle, which is what makes cropping *to* a size possible instead of towards one.
- Both numbers come out of `cropPixelBox`, the function the server crops with (`_crop_box`, rounding included), so the UI cannot report a resolution the run would not produce.

### Changed
- **The gallery counts images by content, so one picture is one entry.** Every upload is stored under a fresh unique name, so pasting the same photo a second time produced a composition the gallery could not recognise: a second entry beside the first, with the same preview and the same everything. Two files of the same size with the same hash are one image now, and the composition they make is one entry whose use count goes up. The duplicate files stop being referenced by anything, so `Clean up unused files…` can reclaim them — they are never deleted behind your back, and a file an open node uses is still off limits.
- One picture used **twice in the same composition** is still two images: duplicating an image on purpose survives this. Entries recorded before the change carry a name-based key and are rehashed once each, then written back, rather than once per run; a file whose bytes cannot be read falls back to its name, as that is all that is known about it.
- **An edited card is outlined like the rest.** A crop or a quarter turn used to turn the whole card border amber, which drew a frame around the picture to say what the ✂ / `90°` badge in its corner — and now the amber size beside it — already say. The border is back to meaning one thing: blue is a card you selected.

## 1.6.0 — 2026-09-14

### Added
- **Zoom and pan in the image editor.** The crop rectangle could only ever be as precise as the image was small: a 4000px photo was drawn at 1000px, so one screen pixel moved the crop by four. The editor now zooms up to **16×** — the wheel zooms around the pointer so the detail under it stays still, `+` / `−` / `Fit` and the keys `+ / - / 0` do it from the middle of the view — and pans with a **middle-button drag** or **space held with the left button**, both of which leave the left button free for drawing a crop. The percentage beside the buttons says where you are.
- The zoom is a view rectangle over the working image, and every pointer position is read through it, so the crop maths never learns about zoom: the grab areas and the minimum crop are a constant number of *screen* pixels and therefore shrink in image pixels as you zoom, which is what makes a crop trimmable to the pixel. A rotation or a flip re-fits the view, since the image it is a window onto has changed shape.

## 1.5.1 — 2026-09-14

### Added
- **Pin a gallery entry (`☆` on its preview).** A pinned entry sorts to the front and the 200-entry cap never drops it, so a composition worth keeping cannot age out behind a hundred experiments. Pinning more than the cap allows lets the gallery grow past it, which is the honest reading of "keep this"; unpinning lets it age normally again.
- The cap also stopped being able to evict **the entry it was just recording**: with everything else pinned it had nothing else to choose, and threw away the composition that triggered it.

## 1.5.0 — 2026-09-14

### Added
- **`grid_target_aspect`: let the grid choose its own columns.** In grid mode, instead of fixing `grid_columns` by hand, name the shape the finished canvas should have — `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3` — and every column count from one to the image count is laid out with the same function the run uses, with the one landing closest to that ratio winning. Eight squares become 4x2 at `16:9`, 3x3 at `1:1` and 2x4 at `9:16`. Closeness is measured on a log scale, so twice too wide and twice too tall cost the same, and a tie keeps the fewer columns. The default `off` keeps `grid_columns` exactly as before, the widget is last in the definition so no saved workflow shifts a slot, and a workflow carrying no value reads as `off`.
- The choice is made once per run, before the estimate, the composition and the `cells` output read it, so all three describe the same grid. The frontend mirrors it (`chooseGridColumns` in `shared.js`) so the in-node preview shows the grid that will be produced, and the parity test compares the two over 250 random cases plus the worked examples.

## 1.4.0 — 2026-09-14

### Added
- **Several cards at once.** A card's **number is its checkbox**: click it to pick that image out, click it again to drop it. Selected cards are outlined and the status line counts them; the node's own menu offers `Select all images` and `Deselect …`. Right-clicking any selected card gives a menu about the whole group — `Crop … to` a shape, `Rotate 90°`, `Flip horizontally` / `vertically`, `Reset the crop`, `Duplicate`, `Move to the front` / `to the end` and `Remove` — and each runs as **one undo step**, not one per image. Dragging one of several selected cards carries the whole group to where it lands, keeping their order.
- `Crop N images to 9:16` (and the other presets) puts the largest centred crop of that shape on each selected image, measured against the image as it is currently rotated. An image whose pixels have not arrived yet is left alone and counted in the notice rather than cropped against a size nobody knows.

### Notes
- Selection is by the number badge because **modifier keys cannot be used here**: the frontend hands a node's `onMouseDown` an event with `ctrlKey`, `shiftKey` and `altKey` all false whichever key is held, and Ctrl-drag is already the canvas's own multi-node selection. Measured in a running ComfyUI before the badge was chosen.
- The selection is dropped whenever the list changes underneath it — a removal, a reorder, an undo, a gallery load — since its indices would then name other cards. The batch edits remap it themselves.

## 1.3.1 — 2026-09-14

### Changed
- **The size panel sets the shape itself.** `size_aspect` arrived as a widget only, so the panel showed what a preset did without being able to pick one. A row of chips under the aspect box — `auto`, `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3` — now sets it with a click, in both the canvas and Vue renderings: the panel is one drawing, so the chips are laid out from the same geometry in both and the DOM click is converted into the panel's own coordinates.

### Tests
- `shared.js` has a coverage floor of 85% (it is at 97%). The rest of the frontend table stays reported: the harness stages `web/` once per test file and the crop editor runs in Chromium, so a threshold over the whole table would measure the split between runners, not the tests. `scripts/coverage-gate.mjs` reads the best row per named file.

## 1.3.0 — 2026-09-14

### Added
- **`size_aspect`: a shape for the `width` / `height` outputs.** They have always followed the reference image, so a 3:4 photo could not ask for 9:16 without a second node. Picking `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2` or `2:3` gives that ratio instead, **keeping the reference image's pixel count** — reshaping does not quietly ask the model for more or fewer pixels — and `size_megapixels` still overrides the area when it is above 0, with `size_divisible_by` snapping as before. The default `reference` is exactly the old behaviour, the widget is last in the definition so no saved workflow shifts a slot, and a workflow that carries no value for it is read as `reference`. The size panel says which shape it used (`from image 1 (1200×1600) at 9:16`), and the frontend mirror is checked against the backend by the parity test over every preset.

### Fixed
- **Nodes 2.0 laid the cards out in three columns whatever the node's width**, while the canvas had followed the width since 1.2.2 — so the same node showed 8 columns in one mode and 3 in the other. Both now call one `columnsForWidth()` in `shared.js`, so they cannot drift again.
- **The Vue view reported a height that assumed a one-row toolbar.** Its nine buttons already wrap to two rows at the default width, leaving the reported height 15px short of what the view occupies; it is measured from the DOM now, and a `ResizeObserver` re-measures when the node is resized or the toolbar rewraps.

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
