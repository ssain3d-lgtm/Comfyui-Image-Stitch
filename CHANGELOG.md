# Changelog

All notable changes to **Multi Stitch Images**. The version is the one in `pyproject.toml`; each release is tagged `v<version>` on `main`.

## 1.2.0 — 2026-09-11

### Added
- **Toolbar row** under the status line: `+ Add · Clear · ⧉ Copy · ↶ ↷ · Preview · Options`. The `Add images…` and `Clear all` button widgets are gone; `+ Add` reads `Cancel k/N` while an upload runs, and the empty dashed box opens the file picker too.
- **Folded advanced options**: `output_limit`, `output_limit_px`, `grid_cell_width`, `grid_cell_height`, `output_cells`, `cells_resolution` and `minimum_image_side` appear only after `Options ▸`. A non-default value stays visible while folded and is counted on the pill (`Options ▸ (2)`); the fold state is saved with the workflow.
- **Copy stitched result** (`⧉ Copy`, or the node's context menu): renders the composite in the browser from the original files at the final size and puts it on the clipboard as PNG. Capped at 64 MP; frames from the IMAGE input are not included; an image that failed to load is left as background, and the notice says so.
- **`match_reference`** (`first` / `largest` / `smallest`): which image `match_image_size` matches the others to. `largest` and `smallest` go by the shared side in a strip and by area in a grid, the reference keeps its own size, and a tie goes to the earlier image. The widget lives under `Options ▸` while matching is on and sits last in the definition, so saved workflows keep their widget slots; a slot an older workflow left empty is reset to the default on load instead of failing validation.
- **Sharp preview**: when the canvas zoom or a HiDPI screen would stretch the 512px thumbnails, the preview band is redrawn from the original files at the size it needs (bounded to 2048px / 4 MP, one cached bitmap per node, re-rendered after a short delay when the layout, the images or the needed size change). Thumbnails, the preview and the copied result now reduce images by halving in steps with high-quality smoothing, so a 4000px source no longer aliases on the way down.
- **Frames from a video**: `+ Add` or a drop accepts a video, which opens a frame picker (play, scrubber, frame steps with `requestVideoFrameCallback` and fps detection, keyboard shortcuts). Each capture uploads the frame on screen as a native-resolution PNG and adds it as an ordinary image, tagged with its source time. The video itself is uploaded only to ComfyUI's temp folder, never saved with the workflow or stitched, and is deleted from the server through a new `/multi_stitch/video/delete` route on the picker's Done, the card's ×, Clear, node removal or leaving the page; ComfyUI's temp cleanup on start-up catches the rest.
- **Server decoding for videos (PyAV)**: three routes — `/multi_stitch/video/info`, `/multi_stitch/video/frame` (JPEG preview at a time) and `/multi_stitch/video/capture` (the decoded frame saved as a PNG in the input folder). The picker switches to server mode when the browser cannot play the file (the card's poster comes from the server too), and a "server capture" checkbox gives a decoder-exact frame for playable videos. Decoding runs off the server's event loop; PyAV missing is reported, not fatal.
- **`width` / `height` outputs and the size panel**: the reference image's size (`size_reference`: the image's number in the list, 1 = the first), rescaled to `size_megapixels` and snapped to `size_divisible_by` (default 32), for an Empty Latent or a resize node. A `📐 Size` button in the title bar (and the context menu) adds a panel under the node showing a box of that aspect with a readout such as `672 x 1184 | 9:16 | 0.80 MP | divisible by 32`; the three widgets appear only while the panel is on, and the state is saved with the workflow. `referenceSize` mirrors `_reference_size`, checked by the parity test.
- **Tooltips** on every widget and on both outputs.
- **Korean UI** (`locales/ko/nodeDefs.json`): widget names, option labels, tooltips and the node description in ComfyUI's Korean locale.
- **Example workflows** (`example_workflows/`, shown in ComfyUI's template browser): paste → strip, and a three-image batch → two-column grid with the `cells` output.
- **Registry publishing** workflow (`.github/workflows/publish_action.yml`): runs when `pyproject.toml` changes on `main`, and skips with a notice until a `REGISTRY_ACCESS_TOKEN` secret exists.

### Changed
- `match_image_size` defaults to `true` and `match_reference` to `smallest` for new nodes, so images line up by height (or width) from the start without anything being upscaled; `output_limit` stays `none`. Saved workflows keep their own values; one saved before `match_reference` existed opens with `first`, as it behaved then, and an API prompt that omits the value gets `first` too.
- A fresh node shows five widgets (`direction`, `match_image_size`, `spacing_width`, `spacing_color`, `layout_mode`) instead of ten rows.
- The status line uses the full node width; the controls moved to the toolbar.
- The thumbnail list no longer scrolls: the node grows downward so every row is visible (the fixed-height list from 1.0 is gone; only the width is resizable).
- The empty dashed box spans the list width instead of one grid cell, so its hint fits inside it; a caption that would still be wider than its box (the empty box, the size panel's hint, the status line) is replaced by a shorter one rather than drawn past the edge.

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
