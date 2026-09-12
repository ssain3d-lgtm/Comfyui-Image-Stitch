import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { openCropEditor } from "./crop_editor.js";
import { canvasToPngFile, captureFileName, formatTime, openFramePicker } from "./frame_picker.js";
import {
    commitImages,
    cropPixelBox,
    drawImageScaled,
    forgetThumb,
    getWidget,
    hideWidget,
    historyOf,
    imageUrl,
    isCropped,
    isTransformed,
    layoutPlacements,
    LEGACY_SIZE_REFERENCES,
    limitedSize,
    loadThumb,
    loadTransformedThumb,
    MAX_IMAGES,
    normalizeCrop,
    normalizeTransform,
    redoImages,
    referenceSize,
    renderTransformedImage,
    retryThumb,
    sizeReferenceIndex,
    resetHistory,
    safeJsonParse,
    setWidgetHidden,
    undoImages,
    uploadFile,
} from "./shared.js";

const NODE_TYPE = "MultiStitchImages";
const THUMB_HEIGHT = 92;
const THUMB_GAP = 7;
const THUMB_COLS = 3;
const MIN_NODE_WIDTH = 420;
// Deliberately measured in browser/client pixels, not graph coordinates, so
// ComfyUI zoom cannot turn a normal click into an accidental reorder.
const DRAG_THRESHOLD_PX = 6;
// The composed-result preview band above the list, and the list itself,
// which shows every row: the node grows downward with the images.
const PREVIEW_HEIGHT = 150;
const ROW_H = THUMB_HEIGHT + THUMB_GAP;
const NAMED_COLORS = { white: "#ffffff", black: "#000000", red: "#ff0000", green: "#00ff00", blue: "#0000ff" };
// "Copy stitched result" renders the composite in the browser. Bounded so a
// canvas the browser cannot allocate or encode fails with a message.
const COPY_MAX_PIXELS = 64 * 1024 * 1024;
// The preview band normally draws the 512px thumbnails. Once the canvas zoom
// or a HiDPI screen would stretch them, the composite is redrawn from the
// original files at the size the band needs — bounded, cached per node, and
// re-rendered only when the layout, the images or the needed size change.
const PREVIEW_RENDER_MAX_SIDE = 2048;
const PREVIEW_RENDER_MAX_PIXELS = 4 * 1024 * 1024;
const PREVIEW_RENDER_STEP = 256;
const PREVIEW_RENDER_DELAY_MS = 150;
// Mirrors _MAX_SOURCE_PIXELS in multi_stitch.py: the most one original may
// hold. A file above it is left to the backend — the sharp preview is skipped
// and the thumbnails stay — because decoding it here would stall the tab.
const SOURCE_MAX_PIXELS = 128 * 1024 * 1024;
// A video is a session-only helper for picking frames: uploaded to ComfyUI's
// temp folder (emptied on restart), never saved with the workflow, never part
// of the stitch, and deleted from the server as soon as its captures are done
// (the card's ×, the picker's Done, Clear, removing the node, leaving the page).
const VIDEO_TARGET = { type: "temp", subfolder: "multi_stitch_video" };
const VIDEO_DELETE_ROUTE = "/multi_stitch/video/delete";
const VIDEO_FRAME_ROUTE = "/multi_stitch/video/frame";
const VIDEO_POSTER_SIDE = 512;
const VIDEO_EXTENSIONS = /\.(mp4|m4v|webm|mov|mkv|ogv|ogg|avi|mpe?g|3gp|ts|wmv)$/i;
const nodesWithVideos = new Set();
// The size panel: an optional strip under the list showing the width and
// height the node outputs — the reference image's size, rescaled to a
// megapixel target and snapped to a multiple — as a box of that aspect with
// a readout, like a resize node's. Toggled from the title bar; saved with the
// workflow; its three widgets show only while it is on.
const SIZE_PANEL_H = 176;
const SIZE_PANEL_BOX_H = 132;
const SIZE_WIDGETS = ["size_reference", "size_megapixels", "size_divisible_by"];
const titleHeight = () => globalThis.LiteGraph?.NODE_TITLE_HEIGHT || 30;
// One toolbar row under the status line holds every action, so no widget
// rows are spent on buttons.
const TOOLBAR_H = 24;
// Options most workflows never touch stay folded behind "Options". A widget
// whose value is not the default stays visible even when folded, so nothing
// acts on the output without showing on the node.
const ADVANCED_DEFAULTS = {
    output_limit: "none",
    output_limit_px: 2048,
    grid_cell_width: 0,
    grid_cell_height: 0,
    output_cells: false,
    cells_resolution: "placed",
    minimum_image_side: 0,
    match_reference: "smallest",
};
// A widget whose slot is missing from a saved workflow gets the value the
// node behaved with before the widget existed, not necessarily today's
// default: match_image_size used to match the first image.
const LEGACY_VALUES = { match_reference: "first" };

function visibleWidgetBottom(node) {
    let bottom = 92;
    for (const widget of node.widgets || []) {
        if (widget._msHidden || widget.hidden || widget.options?.hidden) continue;
        if (Number.isFinite(widget.last_y)) bottom = Math.max(bottom, widget.last_y + 28);
    }
    return bottom;
}

function nodeWidth(node) {
    return Math.max(MIN_NODE_WIDTH, node.size?.[0] || MIN_NODE_WIDTH);
}

function previewEnabled(node) {
    return node.properties?.multi_stitch_preview !== false;
}

function toolbarRect(node) {
    return { x: 8, y: visibleWidgetBottom(node) + 26, w: nodeWidth(node) - 16, h: TOOLBAR_H };
}

function previewRect(node) {
    if (!previewEnabled(node) || !(node._msImages?.length)) return null;
    const bar = toolbarRect(node);
    return { x: 8, y: bar.y + bar.h + 6, w: nodeWidth(node) - 16, h: PREVIEW_HEIGHT };
}

function listTop(node) {
    const preview = previewRect(node);
    if (preview) return preview.y + preview.h + 8;
    const bar = toolbarRect(node);
    return bar.y + bar.h + 6;
}

// Cards in the list: the images, then any videos waiting for capture.
function listCount(node) {
    return (node._msImages?.length || 0) + (node._msVideos?.length || 0);
}

function rowsOf(node) {
    return Math.max(1, Math.ceil(listCount(node) / THUMB_COLS));
}

function heightForRows(node, rows) {
    return listTop(node) + rows * ROW_H - THUMB_GAP + 12 + (sizePanelEnabled(node) ? SIZE_PANEL_H + 8 : 0);
}

function sizePanelEnabled(node) {
    return node.properties?.multi_stitch_size_panel === true;
}

function sizePanelRect(node) {
    if (!sizePanelEnabled(node)) return null;
    return { x: 8, y: listTop(node) + rowsOf(node) * ROW_H - THUMB_GAP + 8, w: nodeWidth(node) - 16, h: SIZE_PANEL_H };
}

function toggleSizePanel(node) {
    node.properties ||= {};
    node.properties.multi_stitch_size_panel = !sizePanelEnabled(node);
    syncConditionalWidgets(node);
    updateNodeSize(node);
    scheduleNodeLayout(node);
    node.graph?.setDirtyCanvas(true, true);
}

// The toggle in the title bar, left of the frontend's help badge at the
// right end (the title runs from -titleHeight() to 0 in node space).
function sizeButtonRect(node) {
    const title = titleHeight();
    const w = 64;
    const h = 20;
    return { x: nodeWidth(node) - 34 - w, y: -title + Math.round((title - h) / 2), w, h };
}

function drawSizeButton(ctx, node) {
    const r = sizeButtonRect(node);
    const on = sizePanelEnabled(node);
    ctx.save();
    ctx.fillStyle = on ? "rgba(74,222,128,.22)" : "rgba(255,255,255,.10)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = on ? "#4ade80" : "rgba(255,255,255,.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    ctx.fillStyle = on ? "#c9f7d9" : "#dcdcdc";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(on ? "📐 Size ✓" : "📐 Size", r.x + r.w / 2, r.y + 14);
    ctx.restore();
}

function gcd(a, b) {
    while (b) [a, b] = [b, a % b];
    return a;
}

function aspectLabel(w, h) {
    const g = gcd(w, h) || 1;
    const a = w / g;
    const b = h / g;
    return a <= 64 && b <= 64 ? `${a}:${b}` : `${(w / h).toFixed(2)}:1`;
}

// What the width/height outputs will be for the current list and settings,
// from the same maths as the backend (referenceSize mirrors _reference_size).
// Null while a thumbnail is still loading.
function sizeReadout(node) {
    const items = node._msImages || [];
    if (!items.length) return null;
    const known = items.map((item) => {
        const state = loadTransformedThumb(node, item);
        if (state.failed) return "failed";
        return transformedCropDims(node, item);
    });
    if (known.some((d) => d === null)) return null;
    const fallback = known.find((d) => d && d !== "failed") || { w: 256, h: 256 };
    const dims = known.map((d) => (d === "failed" ? fallback : d));
    resolvePendingSizeReference(node, dims);
    const settings = readSettings(node);
    try {
        const size = referenceSize(dims, settings.sizeReference, settings.sizeMegapixels, settings.sizeDivisibleBy);
        const index = sizeReferenceIndex(dims, settings.sizeReference);
        const requested = Math.trunc(Number(settings.sizeReference));
        return {
            ...size, index, ref: dims[index], ratio: aspectLabel(dims[index].w, dims[index].h),
            megapixels: size.w * size.h / 1_000_000, step: settings.sizeDivisibleBy,
            note: Number.isFinite(requested) && requested > dims.length ? ` — size_reference ${requested} is past the end` : "",
        };
    } catch (_) {
        return null;
    }
}

// Explanatory text wrapped at measured word boundaries (a "\n" always
// breaks), preserving the font size.
function wrapText(ctx, text, maxWidth) {
    const lines = [];
    for (const paragraph of text.split("\n")) {
        let line = "";
        for (const word of paragraph.split(/\s+/)) {
            const next = line ? `${line} ${word}` : word;
            if (line && (ctx.measureText?.(next)?.width ?? 0) > maxWidth) {
                lines.push(line);
                line = word;
            } else line = next;
        }
        if (line) lines.push(line);
    }
    return lines;
}

function drawWrappedText(ctx, text, x, centerY, maxWidth, lineHeight = 16) {
    const lines = wrapText(ctx, text, maxWidth);
    const startY = centerY - (lines.length - 1) * lineHeight / 2;
    lines.forEach((value, index) => ctx.fillText(value, x, startY + index * lineHeight, maxWidth));
}

function drawSizePanel(ctx, node, rect) {
    ctx.save();
    ctx.fillStyle = "#0c110d";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = "#2f6b45";
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
    const box = { x: rect.x + 8, y: rect.y + 8, w: rect.w - 16, h: SIZE_PANEL_BOX_H };
    ctx.fillStyle = "#050705";
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";

    const readout = sizeReadout(node);
    if (!readout) {
        ctx.fillStyle = "#7fb08f";
        drawWrappedText(ctx,
            node._msImages?.length ? "Loading…" : "Add an image: its size becomes the width / height outputs",
            rect.x + rect.w / 2, box.y + box.h / 2 + 4, box.w - 20,
        );
        ctx.fillText("width / height outputs", rect.x + rect.w / 2, rect.y + rect.h - 12);
        ctx.restore();
        return;
    }

    const inset = 10;
    const scale = Math.min((box.w - inset * 2) / readout.w, (box.h - inset * 2) / readout.h);
    const w = Math.max(2, readout.w * scale);
    const h = Math.max(2, readout.h * scale);
    const x = box.x + (box.w - w) / 2;
    const y = box.y + (box.h - h) / 2;
    ctx.fillStyle = "rgba(74,222,128,.10)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(74,222,128,.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y);
    ctx.lineTo(x + w / 2, y + h);
    ctx.moveTo(x, y + h / 2);
    ctx.lineTo(x + w, y + h / 2);
    ctx.stroke();
    ctx.strokeStyle = "#4ade80";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    ctx.fillStyle = "#e9ffef";
    ctx.font = "13px sans-serif";
    ctx.fillText(
        `${readout.w} x ${readout.h}  |  ${readout.ratio}  |  ${readout.megapixels.toFixed(2)} MP  |  divisible by ${readout.step}`,
        rect.x + rect.w / 2, rect.y + rect.h - 12, rect.w - 16,
    );
    ctx.textAlign = "left";
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#7fb08f";
    ctx.fillText(`from image ${readout.index + 1} (${readout.ref.w}×${readout.ref.h})${readout.note}`, box.x + 6, box.y + 14, box.w - 12);
    ctx.restore();
}

// The window onto the thumbnail rows is the whole list: every row is shown,
// so the scroll fields sit at "nothing to scroll" for the callers that read
// them.
function listViewport(node) {
    const top = listTop(node);
    const rows = rowsOf(node);
    return {
        top, rows, visibleRows: rows, maxScroll: 0, scroll: 0,
        height: rows * ROW_H - THUMB_GAP,
        scrollable: false,
    };
}

// Every card is on the node; `visible` stays because the hit-tests and the
// drawing check it.
function thumbLayout(node, index) {
    const width = nodeWidth(node) - 16;
    const cellW = (width - THUMB_GAP * (THUMB_COLS - 1)) / THUMB_COLS;
    const col = index % THUMB_COLS;
    const row = Math.floor(index / THUMB_COLS);
    return {
        x: 8 + col * (cellW + THUMB_GAP),
        y: listTop(node) + row * ROW_H,
        w: cellW,
        h: THUMB_HEIGHT,
        visible: true,
    };
}

// With nothing in the list, one dashed box spans the list width so its hint
// has room; it is the "add" target as well.
function emptyBoxRect(node) {
    return { x: 8, y: listTop(node), w: nodeWidth(node) - 16, h: THUMB_HEIGHT, visible: true };
}

// Toolbar pills, left to right. Widths are fixed so the whole row fits a
// 420px node: 64+48+56+24+24+70+84 plus six 4px gaps = 394 of 404.
function toolbarControls(node) {
    const bar = toolbarRect(node);
    const y = bar.y + 2;
    const h = bar.h - 4;
    const widths = [["add", 64], ["clear", 48], ["copy", 56], ["undo", 24], ["redo", 24], ["preview", 70], ["options", 84]];
    const rects = {};
    let x = bar.x;
    for (const [name, w] of widths) {
        rects[name] = { x, y, w, h };
        x += w + 4;
    }
    return rects;
}

function advancedOpen(node) {
    return node.properties?.multi_stitch_advanced === true;
}

function isDefaultValue(widget, fallback) {
    const value = widget?.value;
    if (value === undefined || value === null || value === "") return true;
    return String(value) === String(fallback);
}

// Which advanced widgets matter for the current settings, and which of those
// carry a non-default value.
function advancedState(node) {
    const layout = getWidget(node, "layout_mode")?.value || "strip";
    const outputLimit = getWidget(node, "output_limit")?.value || "none";
    const cellsOn = !!getWidget(node, "output_cells")?.value;
    const matching = !!getWidget(node, "match_image_size")?.value;
    const relevant = {
        output_limit: true,
        output_limit_px: outputLimit !== "none",
        grid_cell_width: layout === "grid",
        grid_cell_height: layout === "grid",
        output_cells: true,
        cells_resolution: cellsOn,
        minimum_image_side: true,
        match_reference: matching,
    };
    const active = Object.keys(ADVANCED_DEFAULTS).filter(
        (name) => relevant[name] && !isDefaultValue(getWidget(node, name), ADVANCED_DEFAULTS[name]),
    );
    return { open: advancedOpen(node), relevant, active };
}

function toggleAdvanced(node) {
    node.properties ||= {};
    node.properties.multi_stitch_advanced = !advancedOpen(node);
    syncConditionalWidgets(node);
    scheduleNodeLayout(node);
    node.graph?.setDirtyCanvas(true, true);
}

function thumbActionRects(r) {
    return {
        remove: { x: r.x + r.w - 23, y: r.y + 3, w: 20, h: 19 },
        prev: { x: r.x + 3, y: r.y + r.h - 22, w: 20, h: 19 },
        drag: { x: r.x + r.w / 2 - 13, y: r.y + r.h - 22, w: 26, h: 19 },
        next: { x: r.x + r.w - 23, y: r.y + r.h - 22, w: 20, h: 19 },
    };
}



// The height is never the user's: the node is as tall as its rows, the
// widgets above them and the preview band need. Only the width is kept.
function updateNodeSize(node) {
    if (!node) return;
    const width = nodeWidth(node);
    const height = heightForRows(node, rowsOf(node));
    node.size ||= [width, 0];

    if (node.size[0] !== width || Math.abs(node.size[1] - height) > 0.5) {
        node.setSize?.([width, height]);
        node.size[0] = width;
        node.size[1] = height;
        node.graph?.setDirtyCanvas(true, true);
    }
}

function scheduleNodeLayout(node) {
    if (!node || node._msLayoutScheduled) return;
    node._msLayoutScheduled = true;
    const run = () => {
        node._msLayoutScheduled = false;
        syncConditionalWidgets(node);
        updateNodeSize(node);
        node.graph?.setDirtyCanvas(true, true);
    };
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => requestAnimationFrame(run));
    } else {
        setTimeout(run, 0);
    }
}

function mediaSize(image) {
    return {
        w: image.naturalWidth || image.width || 1,
        h: image.naturalHeight || image.height || 1,
    };
}

function drawContained(ctx, image, crop, rect) {
    const size = mediaSize(image);
    const c = normalizeCrop(crop);
    const sx = c.x * size.w;
    const sy = c.y * size.h;
    const sw = c.w * size.w;
    const sh = c.h * size.h;
    const scale = Math.min(rect.w / sw, rect.h / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
        image,
        sx, sy, sw, sh,
        rect.x + (rect.w - dw) / 2,
        rect.y + (rect.h - dh) / 2,
        dw, dh,
    );
}

function transformedCropDims(node, item) {
    const state = loadTransformedThumb(node, item);
    if (!state.ready) return null;
    // The thumbnail canvas is downscaled; the estimate must use the true size.
    const c = normalizeCrop(item.crop);
    return cropPixelBox(state.width, state.height, c);
}

function readSettings(node) {
    const value = (name, fallback) => {
        const v = getWidget(node, name)?.value;
        return v === undefined || v === null || v === "" ? fallback : v;
    };
    return {
        direction: value("direction", "right"),
        match: !!value("match_image_size", true),
        matchReference: value("match_reference", "smallest"),
        spacing: Math.max(0, Number(value("spacing_width", 0)) || 0),
        layout: value("layout_mode", "strip"),
        gridColumns: Math.max(1, Math.min(16, Number(value("grid_columns", 3)) || 3)),
        cellWidth: Math.max(0, Number(value("grid_cell_width", 0)) || 0),
        cellHeight: Math.max(0, Number(value("grid_cell_height", 0)) || 0),
        outputLimit: value("output_limit", "none"),
        outputLimitPx: Math.max(1, Number(value("output_limit_px", 2048)) || 2048),
        spacingColor: value("spacing_color", "white"),
        customColor: normalizeHex(value("custom_spacing_color", "#808080")),
        sizeReference: value("size_reference", 1),
        sizeMegapixels: Math.max(0, Number(value("size_megapixels", 0)) || 0),
        sizeDivisibleBy: Math.max(1, Math.trunc(Number(value("size_divisible_by", 32)) || 32)),
    };
}

function backgroundColor(settings) {
    return settings.spacingColor === "custom" ? settings.customColor : (NAMED_COLORS[settings.spacingColor] || "#ffffff");
}

// Dimensions and placements the backend will use, from the same layout maths
// (layoutPlacements mirrors _layout). Items still decoding yield null; items
// that failed to load are stood in for by the first known size and flagged.
function plannedLayout(node) {
    const items = node._msImages || [];
    if (!items.length) return null;
    const settings = readSettings(node);
    const known = items.map((item) => {
        const state = loadTransformedThumb(node, item);
        if (state.failed) return "failed";
        return transformedCropDims(node, item);
    });
    if (known.some((d) => d === null)) return null;
    const fallback = known.find((d) => d && d !== "failed") || { w: 256, h: 256 };
    const dims = known.map((d) => (d === "failed" ? fallback : d));
    resolvePendingSizeReference(node, dims);
    let layout;
    try {
        layout = layoutPlacements(
            dims, settings.layout, settings.direction, settings.match,
            settings.gridColumns, settings.spacing, settings.cellWidth, settings.cellHeight,
            settings.matchReference,
        );
    } catch (_) {
        return null;
    }
    const final = limitedSize(layout.width, layout.height, settings.outputLimit, settings.outputLimitPx);
    return {
        ...layout,
        finalWidth: final.w,
        finalHeight: final.h,
        failed: known.map((d) => d === "failed"),
        skipped: known.filter((d) => d === "failed").length,
        settings,
    };
}

function predictedSize(node) {
    const planned = plannedLayout(node);
    return planned ? { w: planned.finalWidth, h: planned.finalHeight, skipped: planned.skipped } : null;
}

function imageInputConnected(node) {
    return (node.inputs || []).some((input) => input?.name === "images" && input.link != null);
}

// The first candidate that fits `maxWidth`, or the shortest one when none
// does: a label is shortened rather than squeezed or spilled.
function fittingLabel(ctx, candidates, maxWidth) {
    const fits = candidates.find((text) => (ctx.measureText?.(text)?.width ?? 0) <= maxWidth);
    return fits ?? candidates[candidates.length - 1];
}

function drawPill(ctx, rect, label, active = true) {
    ctx.fillStyle = active ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.05)";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = active ? "#e8e8e8" : "#6f6f6f";
    ctx.textAlign = "center";
    // maxWidth keeps a long label (a cancel count, a translation) inside the
    // pill instead of spilling over its neighbours.
    ctx.fillText(label, rect.x + rect.w / 2, rect.y + 13, rect.w - 6);
    ctx.textAlign = "left";
}

function drawToolbar(ctx, node) {
    const count = node._msImages?.length || 0;
    const history = historyOf(node);
    const controls = toolbarControls(node);
    const run = node._msUpload;
    const advanced = advancedState(node);
    // "Cancel 100/256" is wider than the 64px pill: drop the word, then the
    // total, before letting the count be squeezed.
    const addLabel = run
        ? fittingLabel(ctx, [`Cancel ${run.done}/${run.total}`, `✕ ${run.done}/${run.total}`, `${run.done}/${run.total}`], controls.add.w - 6)
        : "+ Add";
    drawPill(ctx, controls.add, addLabel);
    drawPill(ctx, controls.clear, "Clear", count > 0 || !!run);
    drawPill(ctx, controls.copy, node._msCopying ? "…" : "⧉ Copy", count > 0 && !node._msCopying);
    drawPill(ctx, controls.undo, "↶", history.past.length > 0);
    drawPill(ctx, controls.redo, "↷", history.future.length > 0);
    drawPill(ctx, controls.preview, previewEnabled(node) ? "Preview ✓" : "Preview", count > 0);
    drawPill(
        ctx,
        controls.options,
        advanced.open ? "Options ▾" : `Options ▸${advanced.active.length ? ` (${advanced.active.length})` : ""}`,
    );
}

function drawPreview(ctx, node, rect) {
    ctx.fillStyle = "#101010";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = "#3a3a3a";
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

    const planned = plannedLayout(node);
    if (!planned) {
        ctx.fillStyle = "#8d8d8d";
        ctx.textAlign = "center";
        ctx.fillText("Loading preview…", rect.x + rect.w / 2, rect.y + rect.h / 2 + 4);
        ctx.textAlign = "left";
        return;
    }

    const inset = 6;
    const scale = Math.min((rect.w - inset * 2) / planned.width, (rect.h - inset * 2) / planned.height);
    const pw = Math.max(1, planned.width * scale);
    const ph = Math.max(1, planned.height * scale);
    const ox = rect.x + (rect.w - pw) / 2;
    const oy = rect.y + (rect.h - ph) / 2;

    ctx.fillStyle = backgroundColor(planned.settings);
    ctx.fillRect(ox, oy, pw, ph);

    const items = node._msImages;
    const pixelScale = devicePixelScale(ctx);
    const contentKey = previewContentKey(node, planned);
    let render = node._msPreviewRender;
    if (needsSharpPreview(node, planned, scale * pixelScale)) {
        render = sharpPreview(node, planned, contentKey, pw * pixelScale, ph * pixelScale);
    }
    const bitmap = render && render.contentKey === contentKey ? (render.canvas || render.previous) : null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (bitmap) ctx.drawImage(bitmap, ox, oy, pw, ph);
    planned.placements.forEach((p, index) => {
        const dest = { x: ox + p.x * scale, y: oy + p.y * scale, w: Math.max(1, p.w * scale), h: Math.max(1, p.h * scale) };
        const state = loadTransformedThumb(node, items[index]);
        if (state.ready && !planned.failed[index]) {
            if (bitmap) return;
            const size = mediaSize(state.image);
            const c = normalizeCrop(items[index].crop);
            ctx.drawImage(
                state.image,
                c.x * size.w, c.y * size.h, c.w * size.w, c.h * size.h,
                dest.x, dest.y, dest.w, dest.h,
            );
        } else {
            ctx.fillStyle = "rgba(255,80,80,.35)";
            ctx.fillRect(dest.x, dest.y, dest.w, dest.h);
            ctx.fillStyle = "#fff";
            ctx.textAlign = "center";
            ctx.fillText("?", dest.x + dest.w / 2, dest.y + dest.h / 2 + 4);
            ctx.textAlign = "left";
        }
    });

    ctx.fillStyle = "rgba(0,0,0,.6)";
    const caption = `Preview  ${planned.finalWidth}×${planned.finalHeight}` +
        (planned.finalWidth !== planned.width ? `  (canvas ${planned.width}×${planned.height})` : "") +
        (imageInputConnected(node) ? "  + IMAGE input at run time" : "");
    ctx.fillRect(rect.x + 1, rect.y + rect.h - 17, rect.w - 2, 16);
    ctx.fillStyle = "#d0d0d0";
    ctx.fillText(caption, rect.x + 8, rect.y + rect.h - 5, rect.w - 16);
}

function drawCard(ctx, node, item, index, r) {
    const actions = thumbActionRects(r);
    const press = node._msThumbPress;
    const isSource = press?.dragging && press.index === index;
    const isTarget = press?.dragging && press.target === index;

    ctx.save();
    if (isSource) ctx.globalAlpha = 0.55;
    ctx.fillStyle = "#171717";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = isTarget
        ? "#8ab4f8"
        : (isCropped(item.crop) || isTransformed(item) ? "#f6b73c" : "#555");
    ctx.lineWidth = isTarget ? 3 : 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);

    const state = loadTransformedThumb(node, item);
    const imageRect = { x: r.x + 3, y: r.y + 3, w: r.w - 6, h: r.h - 6 };

    if (state.ready) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(imageRect.x, imageRect.y, imageRect.w, imageRect.h);
        ctx.clip();
        drawContained(ctx, state.image, item.crop, imageRect);
        ctx.restore();
    } else {
        ctx.fillStyle = state.failed ? "#f08a8a" : "#8d8d8d";
        ctx.textAlign = "center";
        if (state.failed) {
            // Why it has no pixels, and what a click will do about it: a
            // timeout is retried, a format only the server reads is not broken.
            ctx.save();
            ctx.beginPath();
            ctx.rect(imageRect.x, imageRect.y, imageRect.w, imageRect.h);
            ctx.clip();
            drawWrappedText(ctx, state.message || "Load failed · click to relink",
                r.x + r.w / 2, r.y + r.h / 2 + 4, r.w - 10, 14);
            ctx.restore();
        } else {
            ctx.fillText("Loading…", r.x + r.w / 2, r.y + r.h / 2 + 4);
        }
    }

    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(0,0,0,.72)";
    ctx.fillRect(r.x + 3, r.y + 3, 27, 19);
    ctx.fillStyle = "#fff";
    ctx.fillText(String(index + 1), r.x + 11, r.y + 17);

    let badgeX = r.x + 33;
    if (isCropped(item.crop)) {
        ctx.fillStyle = "rgba(0,0,0,.72)";
        ctx.fillRect(badgeX, r.y + 3, 25, 19);
        ctx.fillStyle = "#f6b73c";
        ctx.fillText("✂", badgeX + 6, r.y + 17);
        badgeX += 28;
    }

    if (isTransformed(item)) {
        const t = normalizeTransform(item);
        ctx.fillStyle = "rgba(0,0,0,.72)";
        ctx.fillRect(badgeX, r.y + 3, 48, 19);
        ctx.fillStyle = "#f6b73c";
        ctx.fillText(`${t.rotation}°${t.flip_h ? "H" : ""}${t.flip_v ? "V" : ""}`, badgeX + 4, r.y + 17);
        badgeX += 51;
    }
    if (item.source?.video && badgeX + 58 < r.x + r.w - 26) {
        // A frame captured from a video: where it came from, at a glance.
        ctx.fillStyle = "rgba(0,0,0,.72)";
        ctx.fillRect(badgeX, r.y + 3, 58, 19);
        ctx.fillStyle = "#9ad0ff";
        ctx.fillText(`🎞 ${formatTime(item.source.time).replace(/^00:/, "")}`, badgeX + 4, r.y + 17);
    }

    ctx.fillStyle = "rgba(0,0,0,.76)";
    ctx.fillRect(actions.remove.x, actions.remove.y, actions.remove.w, actions.remove.h);
    ctx.fillRect(actions.prev.x, actions.prev.y, actions.prev.w, actions.prev.h);
    ctx.fillRect(actions.drag.x, actions.drag.y, actions.drag.w, actions.drag.h);
    ctx.fillRect(actions.next.x, actions.next.y, actions.next.w, actions.next.h);
    ctx.fillStyle = "#fff";
    ctx.fillText("×", actions.remove.x + 5, actions.remove.y + 14);
    ctx.fillText("‹", actions.prev.x + 6, actions.prev.y + 15);
    ctx.textAlign = "center";
    ctx.fillText("≡", actions.drag.x + actions.drag.w / 2, actions.drag.y + 14);
    ctx.textAlign = "left";
    ctx.fillText("›", actions.next.x + 6, actions.next.y + 15);
    ctx.restore();
}

function drawVideoCard(ctx, entry, r) {
    ctx.save();
    ctx.fillStyle = "#151a20";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = entry.failed ? "#f08a8a" : "#4a6fa5";
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    const imageRect = { x: r.x + 3, y: r.y + 3, w: r.w - 6, h: r.h - 6 };
    if (entry.poster) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(imageRect.x, imageRect.y, imageRect.w, imageRect.h);
        ctx.clip();
        drawContained(ctx, entry.poster, null, imageRect);
        ctx.restore();
    }
    ctx.textAlign = "center";
    ctx.fillStyle = entry.failed ? "#f08a8a" : "#cfe0ff";
    if (!entry.poster) {
        ctx.fillText(entry.failed ? "Cannot play video" : "🎞 loading…", r.x + r.w / 2, r.y + r.h / 2 - 4, r.w - 10);
    }
    // Both bars are as wide as the card: the name and the footer are clipped
    // to them and measured down to what fits, whatever the card's width.
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x + 3, r.y + 3, r.w - 6, r.h - 6);
    ctx.clip();
    const barWidth = r.w - 10;
    // The name shares its bar with the × button, so it gets the room left of it.
    const nameWidth = Math.max(20, barWidth - 26);
    ctx.fillStyle = "rgba(0,0,0,.72)";
    ctx.fillRect(r.x + 3, r.y + 3, r.w - 6, 19);
    ctx.fillStyle = "#9ad0ff";
    const name = String(entry.name || entry.filename || "video");
    ctx.fillText(fittingLabel(ctx, [`🎞 ${name}`, `🎞 ${name.slice(0, 18)}…`, `🎞 ${name.slice(0, 10)}…`, "🎞"], nameWidth),
        r.x + 3 + nameWidth / 2, r.y + 17, nameWidth);
    ctx.fillStyle = "rgba(0,0,0,.76)";
    ctx.fillRect(r.x + 3, r.y + r.h - 22, r.w - 6, 19);
    ctx.fillStyle = "#e8e8e8";
    const time = entry.duration ? formatTime(entry.duration) : "";
    ctx.fillText(
        fittingLabel(ctx, [
            `${time ? `${time}  ·  ` : ""}click to capture frames`,
            `${time ? `${time}  ·  ` : ""}capture frames`,
            time ? `${time}  ·  capture` : "capture frames",
            time || "capture",
        ], barWidth),
        r.x + r.w / 2, r.y + r.h - 8, barWidth,
    );
    ctx.restore();
    const remove = thumbActionRects(r).remove;
    ctx.fillStyle = "rgba(0,0,0,.76)";
    ctx.fillRect(remove.x, remove.y, remove.w, remove.h);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.fillText("×", remove.x + 5, remove.y + 14);
    ctx.restore();
}

function drawThumbs(node, ctx) {
    if (node.flags?.collapsed) return;

    const items = node._msImages || [];
    const count = items.length;
    const top = visibleWidgetBottom(node) + 8;

    ctx.save();
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "#b8b8b8";
    const predicted = predictedSize(node);
    const noun = `${count} image${count === 1 ? "" : "s"}`;
    const estimate = predicted
        ? `  •  ~${predicted.w}×${predicted.h}${predicted.skipped ? ` (${predicted.skipped} not loaded)` : ""}`
        : "";
    const inputNote = imageInputConnected(node) ? "  + IMAGE input" : "";
    const videos = node._msVideos?.length || 0;
    const videoNote = videos ? `  •  ${videos} video${videos === 1 ? "" : "s"} to capture from` : "";
    // Longest status that still fits the node.
    const candidates = count
        ? [`${noun}${estimate}${inputNote}${videoNote}`, `${noun}${estimate}${videoNote}`, `${noun}${estimate}`, noun]
        : [videos
            ? `${videos} video${videos === 1 ? "" : "s"} — click the card to capture frames`
            : node._msUnreadable
                ? "Image list unreadable — kept as-is. Add or Clear to replace."
                : "Select this node, then Ctrl+V images"];
    const room = nodeWidth(node) - 18;
    const status = candidates.find((text) => (ctx.measureText?.(text)?.width ?? 0) <= room) ?? candidates[candidates.length - 1];
    ctx.textAlign = "left";
    ctx.fillText(status, 9, top + 12, room);
    drawToolbar(ctx, node);

    if (!count && !videos) {
        const r = emptyBoxRect(node);
        ctx.strokeStyle = "#666";
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.setLineDash([]);
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x + 4, r.y + 4, r.w - 8, r.h - 8);
        ctx.clip();
        ctx.fillStyle = "#8f8f8f";
        ctx.textAlign = "center";
        // Both hints as one block, centred on the box: one line each at the
        // usual width, wrapped and stacked if the node were ever narrower.
        const room = r.w - 16;
        // ComfyUI hands only image items to pasteFiles, so a paste is images
        // only; a video arrives by drop or through Add.
        drawWrappedText(ctx, "Paste images · Drop or Add images or a video\nClick to edit · Drag ≡ to reorder", r.x + r.w / 2, r.y + r.h / 2 + 4, room);
        ctx.restore();
        const panel = sizePanelRect(node);
        if (panel) drawSizePanel(ctx, node, panel);
        ctx.restore();
        return;
    }

    const preview = previewRect(node);
    if (preview) drawPreview(ctx, node, preview);

    const viewport = listViewport(node);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, viewport.top - 1, nodeWidth(node), viewport.height + 2);
    ctx.clip();
    items.forEach((item, index) => {
        const r = thumbLayout(node, index);
        if (r.visible) drawCard(ctx, node, item, index, r);
    });
    (node._msVideos || []).forEach((entry, index) => {
        const r = thumbLayout(node, items.length + index);
        if (r.visible) drawVideoCard(ctx, entry, r);
    });
    ctx.restore();

    const panel = sizePanelRect(node);
    if (panel) drawSizePanel(ctx, node, panel);
    ctx.restore();
}

function localPos(node, event, pos, graphCanvas) {
    if (event && typeof event.canvasX === "number") {
        return [event.canvasX - node.pos[0], event.canvasY - node.pos[1]];
    }
    try {
        if (graphCanvas?.convertEventToCanvasOffset) {
            const p = graphCanvas.convertEventToCanvasOffset(event);
            return [p[0] - node.pos[0], p[1] - node.pos[1]];
        }
    } catch (_) {}
    return Array.isArray(pos) ? pos : [0, 0];
}

// Progress shows in the node's title. Two operations can run at once (an
// upload and a copy), so neither may snapshot the title and put it back: they
// share one base title and every suffix is derived from it. A rename made
// while an operation runs wins — the title then no longer matches what was
// last written, and the new name becomes the base.
const TITLE_SUFFIX = /\s+•\s+(?:uploading|rendering copy)\s.*…$/;

function baseTitle(node) {
    if (node._msTitleShown != null && node.title !== node._msTitleShown) {
        node._msBaseTitle = String(node.title ?? "").replace(TITLE_SUFFIX, "");
        node._msTitleShown = null;
    }
    if (node._msBaseTitle == null) node._msBaseTitle = String(node.title ?? "").replace(TITLE_SUFFIX, "");
    return node._msBaseTitle || "Multi Stitch Images";
}

// Shows `suffix` after the base title; null puts the plain base back.
function showProgress(node, suffix) {
    const base = baseTitle(node);
    node.title = suffix ? `${base} • ${suffix}` : base;
    node._msTitleShown = suffix ? node.title : null;
    node.graph?.setDirtyCanvas(true, false);
}

function notify(summary, detail, severity) {
    const toast = app.extensionManager?.toast;
    if (toast?.add) {
        toast.add({ severity: severity || "success", summary, detail, life: 3000 });
    } else if (severity === "error") {
        alert(`${summary}\n${detail}`);
    }
}

async function originalPngBlob(item) {
    const response = await fetch(imageUrl(item));
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const blob = await response.blob();
    if (blob.type === "image/png") return blob;

    // Clipboard image support is effectively PNG-only, so re-encode anything
    // else. This still copies the full original frame, not the edited crop.
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return await new Promise((resolve, reject) => {
        canvas.toBlob(
            (out) => (out ? resolve(out) : reject(new Error("could not encode the image as PNG"))),
            "image/png",
        );
    });
}

async function copyOriginalImage(node, index) {
    const item = node._msImages?.[index];
    if (!item) return;

    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        notify(
            "Copy failed",
            "The clipboard API needs a secure context (https:// or localhost).",
            "error",
        );
        return;
    }

    try {
        try {
            // Handing over the pending promise keeps the click's user gesture
            // alive across the fetch, which Safari requires.
            await navigator.clipboard.write([
                new ClipboardItem({ "image/png": originalPngBlob(item) }),
            ]);
        } catch (_) {
            // Browsers that reject a pending promise inside ClipboardItem.
            const blob = await originalPngBlob(item);
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        }
        notify("Copied", `Original image #${index + 1} copied to the clipboard.`);
    } catch (error) {
        notify("Copy failed", String(error?.message || error), "error");
    }
}

function loadFullImage(url) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`could not load ${url}`));
        image.src = url;
    });
}

function releaseImage(image) {
    image.onload = null;
    image.onerror = null;
    image.src = "";
}

// Only one composite renders at a time across every node: each one decodes
// originals, and several at once is what makes the tab stall. A Copy jumps
// ahead of a preview render, since a click is waiting on it.
const renderQueue = [];
let renderRunning = false;
function pumpRenders() {
    if (renderRunning || !renderQueue.length) return;
    renderRunning = true;
    const { task, resolve, reject } = renderQueue.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => {
        renderRunning = false;
        pumpRenders();
    });
}
function runRender(task, { first = false } = {}) {
    return new Promise((resolve, reject) => {
        const entry = { task, resolve, reject };
        if (first) renderQueue.unshift(entry);
        else renderQueue.push(entry);
        pumpRenders();
    });
}

// A canvas the browser will not allocate comes back with a zero size or no
// context instead of throwing; a blank image on the clipboard would be worse
// than a message, so every allocation is checked.
function allocateCanvas(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.width === w && canvas.height === h ? canvas.getContext("2d") : null;
    if (!ctx) {
        throw new Error(`the browser could not allocate a ${w}×${h} canvas (${(w * h / 1_000_000).toFixed(1)} MP)`);
    }
    return { canvas, ctx };
}

// The source pixels one item needs to fill `dest`: the crop is only a part of
// the image, so the whole image has to be that much bigger. Null while the
// thumbnail has not reported the true size yet.
function neededSourceSize(node, item, dest) {
    const raw = loadThumb(node, item);
    if (!raw.ready || !raw.width || !raw.height) return null;
    const c = normalizeCrop(item.crop);
    let needW = dest.w / Math.max(c.w, 1e-6);
    let needH = dest.h / Math.max(c.h, 1e-6);
    const { rotation } = normalizeTransform(item);
    if (rotation === 90 || rotation === 270) [needW, needH] = [needH, needW];
    // Never above 1: an original is never upscaled before it is drawn.
    const scale = Math.min(1, Math.max(needW / raw.width, needH / raw.height));
    return { width: Math.max(1, Math.round(raw.width * scale)), height: Math.max(1, Math.round(raw.height * scale)) };
}

// One original, decoded to at most the size the destination needs:
// createImageBitmap scales while decoding, so a 24 MP file never becomes a
// 24 MP bitmap for a 300px band. Falls back to <img> where it is unavailable
// (or where the fetch fails), which decodes at full size as before.
async function loadBoundedSource(item, bound) {
    if (bound && typeof createImageBitmap === "function" && typeof fetch === "function") {
        try {
            const response = await fetch(imageUrl(item));
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob, {
                resizeWidth: bound.width, resizeHeight: bound.height, resizeQuality: "high",
            });
            return { source: bitmap, release: () => bitmap.close?.() };
        } catch (_) { /* no bitmap decode here: the <img> path still works */ }
    }
    const image = await loadFullImage(imageUrl(item));
    return { source: image, release: () => releaseImage(image) };
}

// Draws the composite from the original files, one image at a time, into a
// canvas of the given size: the same placements the backend will use. Frames
// from a connected IMAGE input exist only at run time and are not included;
// an image that failed to load is left as background. `alive` lets a caller
// abandon a render that is no longer wanted between images. Resampling is
// the browser's (stepwise, high quality), so a downscaled image can differ
// very slightly from the backend's bicubic result.
async function renderComposite(node, planned, { width, height, onProgress, alive }) {
    const { canvas, ctx } = allocateCanvas(width, height);
    ctx.fillStyle = backgroundColor(planned.settings);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const scaleX = canvas.width / planned.width;
    const scaleY = canvas.height / planned.height;

    const items = node._msImages;
    let skipped = 0;
    for (let index = 0; index < items.length; index++) {
        if (alive && !alive()) return null;
        onProgress?.(index + 1, items.length);
        if (planned.failed[index]) {
            skipped += 1;
            continue;
        }
        const item = items[index];
        const place = planned.placements[index];
        const dest = { x: place.x * scaleX, y: place.y * scaleY, w: place.w * scaleX, h: place.h * scaleY };
        const { source, release } = await loadBoundedSource(item, neededSourceSize(node, item, dest));
        try {
            if (alive && !alive()) return null;
            const view = isTransformed(item) ? renderTransformedImage(source, item, 0) : source;
            const size = mediaSize(view);
            const box = cropPixelBox(size.w, size.h, item.crop);
            drawImageScaled(ctx, view, box.x, box.y, box.w, box.h, dest.x, dest.y, dest.w, dest.h);
        } finally {
            release();
        }
    }
    return { canvas, skipped };
}

// Device pixels per graph unit under the current canvas transform: zoom and
// the HiDPI backing store together.
function devicePixelScale(ctx) {
    const t = ctx.getTransform?.();
    if (!t || !Number.isFinite(t.a) || !Number.isFinite(t.b)) return 1;
    return Math.max(0.01, Math.hypot(t.a, t.b));
}

// An original above the backend's per-image limit is not decoded here at all:
// the band keeps its thumbnails rather than freezing the tab for a file the
// backend will have to refuse anyway.
function sourceAboveLimit(node, planned) {
    const items = node._msImages;
    return items.some((item, index) => {
        if (planned.failed[index]) return false;
        const raw = loadThumb(node, item);
        return raw.ready && raw.width * raw.height > SOURCE_MAX_PIXELS;
    });
}

// True when some image would be drawn larger on screen than its thumbnail
// holds, while the original has more pixels to give.
function needsSharpPreview(node, planned, drawScale) {
    const items = node._msImages;
    if (sourceAboveLimit(node, planned)) return false;
    return planned.placements.some((p, index) => {
        if (planned.failed[index]) return false;
        const state = loadTransformedThumb(node, items[index]);
        if (!state.ready) return false;
        const c = normalizeCrop(items[index].crop);
        const thumb = mediaSize(state.image);
        const have = Math.max(thumb.w * c.w, thumb.h * c.h);
        const native = Math.max(state.width * c.w, state.height * c.h);
        const need = Math.max(p.w, p.h) * drawScale;
        return need > have + 0.5 && have < native - 0.5;
    });
}

// Everything the composite's pixels depend on; the needed size is separate
// so a zoom step can keep showing the previous bitmap while a new one renders.
function previewContentKey(node, planned) {
    const s = planned.settings;
    return JSON.stringify([
        node._msImages.map((i) => [i.type, i.subfolder, i.filename, normalizeCrop(i.crop), normalizeTransform(i)]),
        [s.layout, s.direction, s.match, s.matchReference, s.gridColumns, s.spacing,
            s.cellWidth, s.cellHeight, s.spacingColor, s.customColor],
        planned.failed,
    ]);
}

// The bitmap size the band needs, rounded up in steps so small zoom changes
// reuse the cache, never larger than the composite, and bounded.
function previewRenderSize(planned, deviceWidth, deviceHeight) {
    const step = (v) => Math.ceil(v / PREVIEW_RENDER_STEP) * PREVIEW_RENDER_STEP;
    let scale = Math.min(step(deviceWidth) / planned.width, step(deviceHeight) / planned.height, 1);
    scale = Math.min(scale, PREVIEW_RENDER_MAX_SIDE / Math.max(planned.width, planned.height));
    const pixels = planned.width * planned.height * scale * scale;
    if (pixels > PREVIEW_RENDER_MAX_PIXELS) scale *= Math.sqrt(PREVIEW_RENDER_MAX_PIXELS / pixels);
    return {
        width: Math.max(1, Math.round(planned.width * scale)),
        height: Math.max(1, Math.round(planned.height * scale)),
    };
}

// Returns the node's sharp-preview state for this content and size, starting
// a render (after a short delay, so a zoom gesture or a slider drag settles)
// when there is none yet. The previous bitmap stays on screen while a new
// size renders for the same content.
function sharpPreview(node, planned, contentKey, deviceWidth, deviceHeight) {
    const { width, height } = previewRenderSize(planned, deviceWidth, deviceHeight);
    const key = `${contentKey}|${width}x${height}`;
    const current = node._msPreviewRender;
    if (current?.key === key) return current;
    clearTimeout(current?.timer);
    const render = {
        key,
        contentKey,
        ready: false,
        failed: false,
        canvas: null,
        previous: current?.contentKey === contentKey ? (current.canvas || current.previous) : null,
        timer: null,
    };
    const alive = () => !node._msDisposed && node._msPreviewRender === render;
    render.timer = setTimeout(() => {
        render.timer = null;
        runRender(() => (alive() ? renderComposite(node, planned, { width, height, alive }) : null))
            .then((out) => {
                if (!alive()) return;
                if (out) {
                    render.canvas = out.canvas;
                    render.ready = true;
                    render.previous = null;
                }
                node.graph?.setDirtyCanvas(true, false);
            })
            .catch((error) => {
                if (!alive()) return;
                render.failed = true;
                // A band that silently stays soft is puzzling, and a canvas the
                // browser refused is worth saying out loud — once per content.
                if (node._msPreviewNotice !== contentKey) {
                    node._msPreviewNotice = contentKey;
                    notify(
                        "Sharp preview not rendered",
                        `${String(error?.message || error)} — the thumbnails are shown instead.`,
                        "warn",
                    );
                }
                node.graph?.setDirtyCanvas(true, false);
            });
    }, PREVIEW_RENDER_DELAY_MS);
    node._msPreviewRender = render;
    return render;
}

// Draws the stitched result at its final size for the clipboard.
async function renderStitched(node, onProgress) {
    const planned = plannedLayout(node);
    if (!planned) throw new Error("thumbnails are still loading — try again in a moment");
    if (planned.finalWidth * planned.finalHeight > COPY_MAX_PIXELS) {
        throw new Error(
            `${planned.finalWidth}×${planned.finalHeight} is too large to render in the browser ` +
            `(limit ${Math.round(COPY_MAX_PIXELS / 1_000_000)} MP); set output_limit, or queue the workflow instead`,
        );
    }

    const { canvas, skipped } = await runRender(
        () => renderComposite(node, planned, {
            width: planned.finalWidth,
            height: planned.finalHeight,
            onProgress,
        }),
        // A click is waiting: a Copy goes before any pending preview render.
        { first: true },
    );

    const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
            (out) => (out ? resolve(out) : reject(new Error("could not encode the result as PNG"))),
            "image/png",
        );
    });
    return { blob, width: canvas.width, height: canvas.height, skipped, key: copyCacheKey(node, planned) };
}

// Everything the copied PNG depends on: the same pixels give the same key, so
// a second click can write the rendering the first one produced.
function copyCacheKey(node, planned = plannedLayout(node)) {
    return planned ? `${previewContentKey(node, planned)}|${planned.finalWidth}x${planned.finalHeight}` : null;
}

// Why the clipboard cannot be written: no API at all, or an API the browser
// only offers in a secure context. The two need different answers.
function clipboardUnavailable() {
    const haveApi = typeof navigator !== "undefined" && !!navigator.clipboard?.write && typeof ClipboardItem !== "undefined";
    if (haveApi) return null;
    if (typeof globalThis.isSecureContext === "boolean" && !globalThis.isSecureContext) {
        return "Writing images to the clipboard needs a secure context: open ComfyUI over https:// or on localhost.";
    }
    return "This browser has no clipboard image API (navigator.clipboard.write with ClipboardItem). " +
        "Right-click the node and copy an original, or queue the workflow and save the result.";
}

// "⧉ Copy": the composite as it will be stitched, on the clipboard now,
// without queueing the workflow.
async function copyStitchedResult(node) {
    if (!(node._msImages?.length)) return;
    const unavailable = clipboardUnavailable();
    if (unavailable) {
        notify("Copy failed", unavailable, "error");
        return;
    }
    if (node._msCopying) {
        notify("Still rendering", "The previous copy is still being rendered.", "warn");
        return;
    }

    node._msCopying = true;
    // A rendering already made for these exact pixels is written straight
    // away: Firefox only accepts a write while the click is still fresh, so a
    // second click on the same composition must not wait for a render.
    const cached = node._msCopyRender;
    const key = copyCacheKey(node);
    let result = cached && key && cached.key === key ? cached : null;
    const rendering = result
        ? Promise.resolve(result.blob)
        : renderStitched(node, (done, total) => showProgress(node, `rendering copy ${done}/${total}…`))
            .then((out) => {
                result = out;
                node._msCopyRender = out;
                return out.blob;
            });
    rendering.catch(() => {});  // observed below; keep a render failure from surfacing twice

    try {
        try {
            // The pending promise keeps the click's user gesture alive while
            // the originals load, which Safari requires.
            await navigator.clipboard.write([new ClipboardItem({ "image/png": rendering })]);
        } catch (_) {
            // A render failure rethrows here with its own message; a browser
            // that rejects a pending promise gets the resolved blob instead.
            const blob = await rendering;
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        }
        const notes = [];
        if (result.skipped) notes.push(`${result.skipped} not loaded, left blank`);
        if (imageInputConnected(node)) notes.push("IMAGE input frames not included");
        notify(
            "Copied",
            `Stitched result ${result.width}×${result.height} copied to the clipboard` +
            `${notes.length ? ` (${notes.join("; ")})` : ""}.`,
        );
    } catch (error) {
        // The rendering is kept either way, so the retry this suggests is
        // instant.
        const again = result ? " The rendering is ready — click Copy again and it is written immediately." : "";
        notify("Copy failed", `${String(error?.message || error)}.${again}`, "error");
    } finally {
        node._msCopying = false;
        showProgress(node, null);
        node.graph?.setDirtyCanvas(true, true);
    }
}

function thumbIndexAt(node, graphCanvas) {
    const mouse = graphCanvas?.graph_mouse || graphCanvas?.canvas_mouse;
    if (node.flags?.collapsed || !Array.isArray(mouse)) return -1;
    const x = mouse[0] - node.pos[0];
    const y = mouse[1] - node.pos[1];
    for (let i = 0; i < (node._msImages?.length || 0); i++) {
        const r = thumbLayout(node, i);
        if (r.visible && inRect(x, y, r)) return i;
    }
    return -1;
}

function clientPos(event) {
    const x = Number(event?.clientX);
    const y = Number(event?.clientY);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

const inRect = (x, y, r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

function stopEvent(event) {
    try {
        event?.preventDefault?.();
        event?.stopPropagation?.();
    } catch (_) {}
}

function changed(node) {
    // A real edit replaces whatever unreadable text was preserved on load.
    node._msUnreadable = null;
    // The composition changed, so the PNG kept for a repeated Copy is stale.
    node._msCopyRender = null;
    commitImages(node);
    syncConditionalWidgets(node);
    updateNodeSize(node);
    scheduleNodeLayout(node);
}

function restoreHistory(node, step) {
    if (!step(node)) return false;
    node._msUnreadable = null;
    node._msCopyRender = null;
    node._msTransformedCache?.clear();
    syncConditionalWidgets(node);
    updateNodeSize(node);
    scheduleNodeLayout(node);
    return true;
}

const undo = (node) => restoreHistory(node, undoImages);
const redo = (node) => restoreHistory(node, redoImages);
const canUndo = (node) => historyOf(node).past.length > 0;
const canRedo = (node) => historyOf(node).future.length > 0;

// Replaces the whole list the way the × and undo paths do: one history entry,
// the widget and the property in step, the thumbnails of the new files on their
// way and the node's height brought up to date. `pushHistory: false` writes the
// list without making the change undoable (loading a workflow, adopting a
// stash).
function applyImages(node, items, { pushHistory = true } = {}) {
    const next = normalizeItems(items);
    // Only the entries that are gone lose their cached pixels; a file still in
    // the list keeps its decode.
    for (const item of node._msImages || []) forgetThumb(node, item, next);
    node._msImages = next;
    if (!pushHistory) node._msCommitted = JSON.stringify(next);
    changed(node);
    for (const item of next) loadTransformedThumb(node, item);
    node.graph?.setDirtyCanvas(true, true);
    return next;
}

function removeImageAt(node, index) {
    const list = node._msImages || [];
    if (!(index >= 0 && index < list.length)) return false;
    const [removed] = list.splice(index, 1);
    forgetThumb(node, removed, list);
    changed(node);
    return true;
}

function clearAllImages(node) {
    const count = node._msImages?.length || 0;
    const videos = node._msVideos?.length || 0;
    const what = [count ? `${count} image${count === 1 ? "" : "s"}` : "", videos ? `${videos} video${videos === 1 ? "" : "s"}` : ""]
        .filter(Boolean).join(" and ");
    if ((count || videos) && !confirm(`Remove all ${what} from this node?`)) return;
    cancelUpload(node);
    removeAllVideos(node);
    node._msImages = [];
    node._msThumbCache?.clear();
    node._msTransformedCache?.clear();
    changed(node);
}

function togglePreview(node) {
    node.properties ||= {};
    node.properties.multi_stitch_preview = !previewEnabled(node);
    updateNodeSize(node);
    node.graph?.setDirtyCanvas(true, true);
}

// Relink one entry to a new file, keeping its crop, transform and position:
// the answer to a workflow whose source files moved.
function replaceImage(node, index) {
    const item = node._msImages?.[index];
    if (!item) return;
    const { input, removeOnce } = transientInput("file");
    input.accept = "image/*";
    input.addEventListener("change", async () => {
        try {
            const file = Array.from(input.files || []).find((f) => f.type?.startsWith("image/"));
            if (!file) return;
            const uploaded = await uploadFile(file);
            const current = node._msImages?.indexOf(item);
            if (current === undefined || current < 0) return;
            // Only this entry's pixels are dropped; the rest of the list keeps
            // its decodes instead of being downloaded again.
            forgetThumb(node, item, (node._msImages || []).filter((other) => other !== item));
            Object.assign(item, { filename: uploaded.filename, subfolder: uploaded.subfolder, type: uploaded.type });
            // The new file is not the captured frame the old one was, so the
            // 🎞 badge and its timestamp no longer describe it.
            delete item.source;
            changed(node);
            notify("Image replaced", `Image #${current + 1} now points at ${uploaded.filename}; its crop and order were kept.`);
        } catch (error) {
            notify("Replace failed", String(error?.message || error), "error");
        } finally {
            removeOnce();
        }
    }, { once: true });
    input.click();
}

function moveItem(node, index, delta) {
    const target = index + delta;
    if (target < 0 || target >= node._msImages.length) return false;
    const [item] = node._msImages.splice(index, 1);
    node._msImages.splice(target, 0, item);
    changed(node);
    return true;
}

function reorderItem(node, from, to) {
    if (from === to || from < 0 || to < 0 || from >= node._msImages.length || to >= node._msImages.length) return;
    const [item] = node._msImages.splice(from, 1);
    node._msImages.splice(to, 0, item);
    changed(node);
}

function nearestThumbIndex(node, x, y) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < node._msImages.length; i++) {
        const r = thumbLayout(node, i);
        if (!r.visible) continue;
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < bestD) {
            best = i;
            bestD = d;
        }
    }
    return best;
}

function usableItem(item) {
    // The backend keeps only dict entries with a resolvable filename, so drop
    // the rest here too instead of rendering them as broken thumbnails.
    return !!item && typeof item === "object" && typeof item.filename === "string" && !!item.filename;
}

function normalizeItem(item) {
    return {
        ...item,
        crop: normalizeCrop(item.crop),
        ...normalizeTransform(item),
    };
}

function normalizeItems(list) {
    const items = Array.isArray(list) ? list : [];
    const usable = items.filter(usableItem);
    if (usable.length !== items.length) {
        console.warn(
            `[Multi Stitch Images] dropped ${items.length - usable.length} image entr` +
            `${items.length - usable.length === 1 ? "y" : "ies"} with no filename.`,
        );
    }
    return usable.map(normalizeItem);
}

function syncUploadUi(node) {
    const run = node._msUpload;
    if (run) showProgress(node, `uploading ${run.done}/${run.total}…`);
    node.graph?.setDirtyCanvas(true, false);
}

// Stops the current upload run. Images already added stay; the one in flight
// is aborted, and a response that still arrives is discarded because the run
// no longer matches the node's upload generation.
function cancelUpload(node) {
    const run = node._msUpload;
    if (!run) return false;
    node._msUploadGeneration = (node._msUploadGeneration || 0) + 1;
    run.abort.abort();
    return true;
}

function isVideoFile(file) {
    return !!file && (String(file.type || "").startsWith("video/") || VIDEO_EXTENSIONS.test(file.name || ""));
}

async function addFiles(node, files) {
    const picked = Array.from(files || []).filter((file) => file && (file.type?.startsWith("image/") || isVideoFile(file)));
    const images = picked.filter((file) => !isVideoFile(file));
    const videos = picked.filter(isVideoFile);
    if (!picked.length) return;
    if (node._msUpload) {
        // Uploads run sequentially and can take seconds, so say why nothing
        // happened rather than swallowing the paste.
        const run = node._msUpload;
        notify(
            "Upload in progress",
            `Still uploading (${run.done}/${run.total}) — ${picked.length} file(s) were not added. ` +
            "Wait for it, or click Cancel in the toolbar.",
            "warn",
        );
        return;
    }

    // The backend refuses more than MAX_IMAGES at run time; refusing here
    // saves uploading files that could never be used.
    const remaining = MAX_IMAGES - (node._msImages?.length || 0);
    let queue = images;
    if (images.length && remaining <= 0) {
        notify(
            "Image limit reached",
            `This node holds at most ${MAX_IMAGES} images. Remove some before adding more.`,
            "warn",
        );
        queue = [];
    } else if (queue.length > remaining) {
        notify(
            "Image limit",
            `Only ${remaining} more image${remaining === 1 ? "" : "s"} fit (max ${MAX_IMAGES}); ` +
            `${queue.length - remaining} skipped.`,
            "warn",
        );
        queue = queue.slice(0, remaining);
    }
    queue = [...queue, ...videos];
    if (!queue.length) return;
    const addedVideos = [];

    node._msUploadGeneration = (node._msUploadGeneration || 0) + 1;
    const run = {
        generation: node._msUploadGeneration,
        abort: new AbortController(),
        total: queue.length,
        done: 0,
    };
    node._msUpload = run;
    syncUploadUi(node);

    try {
        for (const file of queue) {
            if (isVideoFile(file)) {
                const uploaded = await uploadFile(file, run.abort.signal, VIDEO_TARGET);
                const entry = {
                    kind: "video", filename: uploaded.filename, subfolder: uploaded.subfolder, type: uploaded.type,
                    name: file.name || uploaded.filename, poster: null, duration: null, width: 0, height: 0, failed: false,
                };
                if (node._msUploadGeneration !== run.generation) {
                    deleteTempVideos([entry]);
                    break;
                }
                (node._msVideos ||= []).push(entry);
                nodesWithVideos.add(node);
                installUnloadCleanup();
                addedVideos.push(entry);
                loadVideoPoster(node, entry);
                run.done += 1;
                updateNodeSize(node);
                syncUploadUi(node);
                continue;
            }
            const item = await uploadFile(file, run.abort.signal);
            // Clear or Cancel ran during the await: the file is on
            // disk, but it must not reappear on a list the user just reset.
            if (node._msUploadGeneration !== run.generation) break;
            node._msImages.push(item);
            run.done += 1;
            changed(node);
            syncUploadUi(node);
        }
        // One video added: go straight to picking frames from it.
        if (addedVideos.length === 1 && !node._msDisposed) openVideoPicker(node, addedVideos[0]);
    } catch (error) {
        if (error?.name !== "AbortError") {
            console.error("[Multi Stitch Images]", error);
            notify("Upload failed", String(error?.message || error), "error");
        }
    } finally {
        if (node._msUpload === run) node._msUpload = null;
        // The base title comes back; another operation's suffix, if one is
        // still running, is written again by its own progress.
        showProgress(node, null);
        node.graph?.setDirtyCanvas(true, true);
    }
}

// An OS file/colour dialog closed with Escape fires no change event, and the
// `cancel` event is not carried everywhere, so also drop the element once focus
// returns to the page. removeOnce keeps that idempotent.
function transientInput(type) {
    const input = document.createElement("input");
    input.type = type;
    input.style.display = "none";
    document.body.appendChild(input);

    let done = false;
    const removeOnce = () => {
        if (done) return;
        done = true;
        window.removeEventListener("focus", onFocus, true);
        input.remove();
    };
    const onFocus = () => setTimeout(removeOnce, 500);
    window.addEventListener("focus", onFocus, true);
    input.addEventListener("cancel", removeOnce, { once: true });
    return { input, removeOnce };
}

// --- Videos: session-only sources for frame capture -------------------------

function loadVideoPoster(node, entry) {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    video.playsInline = true;
    const release = () => {
        video.onloadedmetadata = video.onseeked = video.onerror = null;
        try { video.removeAttribute?.("src"); video.load?.(); } catch (_) { /* discarded */ }
    };
    video.onerror = () => {
        // The browser cannot decode it: the server (PyAV) may still be able to.
        release();
        loadServerPoster(node, entry);
    };
    video.onloadedmetadata = () => {
        entry.width = video.videoWidth || 0;
        entry.height = video.videoHeight || 0;
        entry.duration = Number.isFinite(video.duration) ? video.duration : null;
        try {
            video.currentTime = Math.min(0.1, (entry.duration || 1) / 2);
        } catch (_) { release(); }
    };
    video.onseeked = () => {
        try {
            const w = video.videoWidth;
            const h = video.videoHeight;
            if (w && h) {
                const scale = Math.min(1, VIDEO_POSTER_SIDE / Math.max(w, h));
                const poster = document.createElement("canvas");
                poster.width = Math.max(1, Math.round(w * scale));
                poster.height = Math.max(1, Math.round(h * scale));
                drawImageScaled(poster.getContext("2d"), video, 0, 0, w, h, 0, 0, poster.width, poster.height);
                entry.poster = poster;
            }
        } catch (_) { /* a poster is a nicety */ }
        release();
        node.graph?.setDirtyCanvas(true, false);
    };
    video.src = imageUrl(entry);
}

// A poster rendered by the server for a video the browser cannot play; when
// it arrives the picker knows to skip the <video> and decode on the server.
function loadServerPoster(node, entry) {
    const image = new Image();
    image.onload = () => {
        try {
            const w = image.naturalWidth || image.width;
            const h = image.naturalHeight || image.height;
            if (w && h) {
                const poster = document.createElement("canvas");
                poster.width = w;
                poster.height = h;
                poster.getContext("2d").drawImage(image, 0, 0, w, h);
                entry.poster = poster;
                entry.width = Math.max(entry.width || 0, w);
                entry.height = Math.max(entry.height || 0, h);
            }
        } catch (_) { /* a poster is a nicety */ }
        entry.serverOnly = true;
        node.graph?.setDirtyCanvas(true, false);
    };
    image.onerror = () => {
        entry.failed = true;
        node.graph?.setDirtyCanvas(true, false);
    };
    const query = new URLSearchParams({ filename: entry.filename, time: "0.1", max_side: String(VIDEO_POSTER_SIDE) });
    image.src = api.apiURL(`${VIDEO_FRAME_ROUTE}?${query.toString()}`);
}

async function deleteTempVideos(entries) {
    const filenames = entries.map((entry) => entry.filename).filter(Boolean);
    if (!filenames.length) return;
    try {
        const response = await api.fetchApi(VIDEO_DELETE_ROUTE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filenames }),
        });
        if (!response.ok) console.warn(`[Multi Stitch Images] could not delete ${filenames.join(", ")}: ${response.status}`);
    } catch (error) {
        console.warn("[Multi Stitch Images] could not delete the temporary video", error);
    }
}

function removeVideo(node, entry, { silent = false } = {}) {
    const list = node._msVideos || [];
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
    if (!list.length) nodesWithVideos.delete(node);
    if (node._msPicker?.entry === entry) node._msPicker.close(false);
    deleteTempVideos([entry]);
    if (!silent) notify("Video removed", `${entry.name || entry.filename} was deleted from the server; captured frames stay.`);
    updateNodeSize(node);
    node.graph?.setDirtyCanvas(true, true);
}

function removeAllVideos(node) {
    const entries = [...(node._msVideos || [])];
    if (!entries.length) return;
    node._msVideos = [];
    nodesWithVideos.delete(node);
    node._msPicker?.close(false);
    deleteTempVideos(entries);
}

// ComfyUI's own Ctrl+Z (changeTracker.undo → app.loadGraphData) throws every
// node away and builds new ones: onRemoved runs, then onConfigure on a fresh
// instance with the same id. Deleting the pending videos and forgetting the
// edit history there would make one Ctrl+Z destroy a video the user is still
// capturing from, so a removal parks that session state for a moment and a
// node configured with the same id adopts it. Nothing adopts it within the
// window: the videos are deleted as before.
const SESSION_STASH_MS = 2000;
const stashedSessions = new Map();

function stashSession(node) {
    const videos = [...(node._msVideos || [])];
    const history = historyOf(node);
    const past = [...history.past];
    const future = [...history.future];
    if (!videos.length && !past.length && !future.length) return;
    const id = node.id;
    if (id === undefined || id === null) {
        // No id to match a new instance by: the temp videos still have to go.
        deleteTempVideos(videos);
        return;
    }
    dropStash(id, { deleteVideos: true });
    const stash = { videos, past, future, timer: null };
    stash.timer = setTimeout(() => dropStash(id, { deleteVideos: true }), SESSION_STASH_MS);
    stashedSessions.set(id, stash);
}

function dropStash(id, { deleteVideos = false } = {}) {
    const stash = stashedSessions.get(id);
    if (!stash) return null;
    clearTimeout(stash.timer);
    stashedSessions.delete(id);
    if (deleteVideos && stash.videos.length) deleteTempVideos(stash.videos);
    return stash;
}

// Takes over a stash left by the same node id moments ago: the videos are
// still on the server, and undo still reaches back past the reload.
function adoptSession(node) {
    const stash = dropStash(node.id);
    if (!stash) return false;
    if (stash.videos.length) {
        node._msVideos = stash.videos;
        nodesWithVideos.add(node);
        installUnloadCleanup();
    }
    const history = historyOf(node);
    history.past = stash.past;
    history.future = stash.future;
    return true;
}

// Leaving the page (reload, close) is the one exit the node cannot see:
// a beacon asks the server to drop every video still waiting for capture.
let unloadCleanupInstalled = false;
function installUnloadCleanup() {
    if (unloadCleanupInstalled || typeof window === "undefined") return;
    unloadCleanupInstalled = true;
    window.addEventListener("pagehide", () => {
        const filenames = [
            ...[...nodesWithVideos].flatMap((node) => (node._msVideos || []).map((entry) => entry.filename)),
            // A stash nobody adopted before the page went away counts too.
            ...[...stashedSessions.values()].flatMap((stash) => stash.videos.map((entry) => entry.filename)),
        ];
        if (!filenames.length || typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return;
        try {
            navigator.sendBeacon(api.apiURL(VIDEO_DELETE_ROUTE), new Blob([JSON.stringify({ filenames })], { type: "application/json" }));
        } catch (_) { /* best effort; ComfyUI clears its temp folder on restart */ }
    });
}

async function addCapturedFrame(node, entry, canvas, time) {
    if ((node._msImages?.length || 0) >= MAX_IMAGES) {
        throw new Error(`This node holds at most ${MAX_IMAGES} images. Remove some before capturing more.`);
    }
    const file = await canvasToPngFile(canvas, captureFileName(entry, time));
    const item = await uploadFile(file);
    item.source = { video: entry.name || entry.filename, time: +Number(time).toFixed(3) };
    if (node._msDisposed) return item;
    node._msImages.push(item);
    changed(node);
    return item;
}

// A frame the server decoded and saved (PyAV): already an input file, so it
// joins the list exactly like an uploaded capture.
function addServerFrame(node, entry, data, time) {
    if ((node._msImages?.length || 0) >= MAX_IMAGES) {
        throw new Error(`This node holds at most ${MAX_IMAGES} images. Remove some before capturing more.`);
    }
    const item = normalizeItem({
        filename: data.name, subfolder: data.subfolder || "multi_stitch", type: data.type || "input",
        crop: null, rotation: 0, flip_h: false, flip_v: false,
    });
    item.source = { video: entry.name || entry.filename, time: +Number(data.time ?? time).toFixed(3), server: true };
    if (node._msDisposed) return item;
    node._msImages.push(item);
    changed(node);
    return item;
}

// Two pickers would fight over the keyboard and over which video the next
// capture belongs to, so only one is open at a time, on any node.
let openPicker = null;

function openVideoPicker(node, entry) {
    if (node._msPicker) return;
    // Whatever was open keeps its video ("keep & close"): only the overlay goes.
    if (openPicker) openPicker.close(false);
    try {
        const picker = openFramePicker(node, entry, {
            onCapture: (canvas, time) => addCapturedFrame(node, entry, canvas, time),
            onServerFrame: (data, time) => addServerFrame(node, entry, data, time),
            onDone: () => removeVideo(node, entry),
            onClose: () => {
                if (node._msPicker === picker) node._msPicker = null;
                if (openPicker === picker) openPicker = null;
                node.graph?.setDirtyCanvas(true, true);
            },
        });
        picker.entry = entry;
        node._msPicker = picker;
        openPicker = picker;
    } catch (error) {
        node._msPicker = null;
        console.warn("[Multi Stitch Images] frame picker", error);
    }
}

function videoIndexAt(node, graphCanvas) {
    const mouse = graphCanvas?.graph_mouse || graphCanvas?.canvas_mouse;
    if (node.flags?.collapsed || !Array.isArray(mouse)) return -1;
    const x = mouse[0] - node.pos[0];
    const y = mouse[1] - node.pos[1];
    const images = node._msImages?.length || 0;
    for (let i = 0; i < (node._msVideos?.length || 0); i++) {
        const r = thumbLayout(node, images + i);
        if (r.visible && inRect(x, y, r)) return i;
    }
    return -1;
}

function chooseFiles(node) {
    const { input, removeOnce } = transientInput("file");
    input.accept = "image/*,video/*";
    input.multiple = true;
    input.addEventListener("change", async () => {
        try {
            await addFiles(node, input.files);
        } finally {
            removeOnce();
        }
    }, { once: true });
    input.click();
}

function normalizeHex(value) {
    const s = String(value || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
    if (/^#[0-9a-f]{3}$/i.test(s)) {
        return ("#" + s.slice(1).split("").map((c) => c + c).join("")).toUpperCase();
    }
    return "#808080";
}

function setWidgetVisible(widget, visible) {
    if (!widget) return;
    const hidden = !visible;
    if (widget._msHidden === hidden) return;
    setWidgetHidden(widget, hidden);
}

function syncConditionalWidgets(node) {
    const layout = getWidget(node, "layout_mode")?.value || "strip";
    const spacingColor = getWidget(node, "spacing_color")?.value || "white";
    setWidgetVisible(getWidget(node, "grid_columns"), layout === "grid");
    setWidgetVisible(getWidget(node, "custom_color_picker"), spacingColor === "custom");

    const { open, relevant, active } = advancedState(node);
    for (const name of Object.keys(ADVANCED_DEFAULTS)) {
        setWidgetVisible(getWidget(node, name), relevant[name] && (open || active.includes(name)));
    }
    for (const name of SIZE_WIDGETS) setWidgetVisible(getWidget(node, name), sizePanelEnabled(node));
}

function updateCustomColorButton(node) {
    const value = normalizeHex(getWidget(node, "custom_spacing_color")?.value);
    const button = node.widgets?.find((w) => w.name === "custom_color_picker");
    if (button) button.label = `Custom color: ${value}`;
    node.graph?.setDirtyCanvas(true, false);
}

function chooseCustomColor(node) {
    const widget = getWidget(node, "custom_spacing_color");
    if (!widget) return;

    const { input, removeOnce } = transientInput("color");
    input.value = normalizeHex(widget.value);

    const apply = () => {
        const old = widget.value;
        widget.value = input.value.toUpperCase();
        widget.callback?.(widget.value);
        node.onWidgetChanged?.(widget.name, widget.value, old, widget);
        updateCustomColorButton(node);
        node.graph?.setDirtyCanvas(true, true);
    };

    input.addEventListener("input", apply);
    input.addEventListener("change", () => {
        apply();
        removeOnce();
    }, { once: true });
    input.click();
}

function openEditor(node, index) {
    if (!node || node._msEditorOpening) return;
    const item = node._msImages?.[index];
    if (!item) return;
    const state = loadTransformedThumb(node, item);
    if (state.failed) {
        // A load that ran out of time may simply have been a slow server: try
        // once more before offering to relink. Anything else cannot be edited.
        if (state.reason === "timeout" && !state.retried) {
            retryThumb(node, item);
            notify("Loading again", `Image #${index + 1} timed out; trying once more.`, "info");
            node.graph?.setDirtyCanvas(true, false);
            return;
        }
        replaceImage(node, index);
        return;
    }
    node._msEditorOpening = true;
    // The editor puts its handle on node._msEditor itself, so a removed node
    // can close it.
    Promise.resolve(openCropEditor(node, index))
        .catch((error) => {
            console.error("[Multi Stitch Images] crop editor", error);
            notify("Cannot edit this image", String(error?.message || error), "error");
        })
        .finally(() => {
            node._msEditorOpening = false;
        });
}

function detachPressFallback(press) {
    if (!press) return;
    if (press.windowPointerUp) {
        window.removeEventListener("pointerup", press.windowPointerUp, true);
        window.removeEventListener("mouseup", press.windowPointerUp, true);
        press.windowPointerUp = null;
    }
    if (press.windowPointerMove) {
        window.removeEventListener("pointermove", press.windowPointerMove, true);
        press.windowPointerMove = null;
    }
}

// Shared by the node's onMouseMove and the window-level pointermove fallback,
// so both paths advance the same drag state.
function updateThumbnailDrag(node, x, y, event) {
    const press = node?._msThumbPress;
    if (!press || press.finished) return false;

    press.currentX = x;
    press.currentY = y;
    if (!press.dragging && dragDistancePx(press, event, x, y) >= DRAG_THRESHOLD_PX) {
        press.dragging = true;
    }
    if (press.dragging) {
        const nearest = nearestThumbIndex(node, x, y);
        if (nearest >= 0) press.target = nearest;
    }
    node.graph?.setDirtyCanvas(true, false);
    return true;
}

function finishThumbnailDrag(node) {
    const press = node?._msThumbPress;
    if (!press || press.finished) return false;

    press.finished = true;
    detachPressFallback(press);
    node._msThumbPress = null;

    if (press.dragging) reorderItem(node, press.index, press.target);

    node.graph?.setDirtyCanvas(true, false);
    return true;
}

function startThumbnailDrag(node, index, localX, localY, event, graphCanvas) {
    const client = clientPos(event);
    const press = {
        index,
        target: index,
        startX: localX,
        startY: localY,
        currentX: localX,
        currentY: localY,
        startClientX: client?.[0] ?? null,
        startClientY: client?.[1] ?? null,
        dragging: false,
        finished: false,
        graphCanvas,
        windowPointerUp: null,
    };

    // Node-level mouseup can be swallowed by canvas capture/selection. Keep a
    // capture-phase fallback so drag state is always released cleanly.
    press.windowPointerUp = () => {
        setTimeout(() => finishThumbnailDrag(node), 0);
    };
    window.addEventListener("pointerup", press.windowPointerUp, true);
    window.addEventListener("mouseup", press.windowPointerUp, true);

    // LGraphNode.captureInput is deprecated and slated for removal, and it was
    // the only thing keeping onMouseMove alive once the pointer left the node.
    // Track the pointer on window instead, which needs no LiteGraph internals.
    press.windowPointerMove = (moveEvent) => {
        const [mx, my] = localPos(node, moveEvent, null, graphCanvas);
        updateThumbnailDrag(node, mx, my, moveEvent);
    };
    window.addEventListener("pointermove", press.windowPointerMove, true);

    // Releasing any previous press first keeps its window listeners from leaking.
    if (node._msThumbPress) detachPressFallback(node._msThumbPress);
    node._msThumbPress = press;
}

function dragDistancePx(press, event, localX, localY) {
    const client = clientPos(event);
    if (client && press.startClientX != null && press.startClientY != null) {
        return Math.hypot(client[0] - press.startClientX, client[1] - press.startClientY);
    }
    // Old/odd canvas event fallback. This is only used if client coordinates are absent.
    return Math.hypot(localX - press.startX, localY - press.startY);
}

// A widget added after a workflow was saved gets whatever sat in its slot of
// widgets_values — nothing, or the null a removed button widget left behind.
// Put a valid value back (the legacy behaviour where it differs from the
// definition's default) so the run does not fail validation.
function restoreInvalidWidgetValues(node) {
    const defaults = node._msWidgetDefaults;
    if (!defaults) return [];
    const restored = [];
    for (const widget of node.widgets || []) {
        if (widget.type === "button" || !defaults.has(widget.name)) continue;
        const choices = widget.options?.values;
        const value = widget.value;
        const invalid = value === undefined || value === null
            || (Array.isArray(choices) && choices.length > 0 && !choices.includes(value))
            || (widget.type === "number" && !Number.isFinite(Number(value)));
        if (!invalid) continue;
        // size_reference was briefly a name. The names still resolve (in
        // sizeReferenceIndex and in the backend), so resetting one to 1 would
        // quietly change the width/height outputs of a saved workflow: keep 1
        // for now and resolve the name once the sizes are known.
        const legacyName = widget.name === "size_reference"
            && LEGACY_SIZE_REFERENCES.includes(String(value).trim().toLowerCase())
            ? String(value).trim().toLowerCase() : null;
        if (legacyName) node._msPendingSizeReference = legacyName;
        widget.value = widget.name in LEGACY_VALUES ? LEGACY_VALUES[widget.name] : defaults.get(widget.name);
        restored.push(legacyName ? `${widget.name} (resolving "${legacyName}")` : widget.name);
    }
    return restored;
}

// Turns a remembered legacy size_reference name into the image number it
// names, now that the thumbnails have reported the sizes. Called wherever the
// dimensions become available, so it happens with the panel open or closed.
function resolvePendingSizeReference(node, dims) {
    const pending = node._msPendingSizeReference;
    if (!pending || !dims?.length) return;
    let index;
    try {
        index = sizeReferenceIndex(dims, pending);
    } catch (_) {
        return;
    }
    node._msPendingSizeReference = null;
    const widget = getWidget(node, "size_reference");
    if (!widget || widget.value === index + 1) return;
    widget.value = index + 1;
    console.warn(`[Multi Stitch Images] size_reference "${pending}" resolved to image ${index + 1} of ${dims.length}`);
    node.graph?.setDirtyCanvas(true, false);
}

function setupNode(node) {
    node._msDisposed = false;
    node.previewMediaType = "image";
    node.properties ||= {};
    node._msWidgetDefaults = new Map((node.widgets || []).map((w) => [w.name, w.value]));

    const imagesWidget = getWidget(node, "images_json");
    hideWidget(imagesWidget);
    const colorWidget = getWidget(node, "custom_spacing_color");
    hideWidget(colorWidget);

    const fromWidget = safeJsonParse(imagesWidget?.value);
    const fromProps = safeJsonParse(node.properties.multi_stitch_images);
    node._msImages = normalizeItems(fromWidget?.length ? fromWidget : fromProps ?? fromWidget);
    node._msThumbCache = new Map();
    node._msTransformedCache = new Map();
    node._msVideos = [];
    resetHistory(node);

    if (!node.widgets?.some((w) => w.name === "custom_color_picker")) {
        const picker = node.addWidget("button", "custom_color_picker", null, () => chooseCustomColor(node));
        picker.serialize = false;
    }

    updateCustomColorButton(node);
    syncConditionalWidgets(node);
    node.pasteFiles = (files) => addFiles(node, files);
    // A frame captured from one of the node's videos, as the picker does it.
    node.captureVideoFrame = (entry, canvas, time) => addCapturedFrame(node, entry, canvas, time);
    changed(node);
    scheduleNodeLayout(node);
}

app.registerExtension({
    name: "ssain3d.MultiStitchImages",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = created?.apply(this, arguments);
            setupNode(this);
            return r;
        };

        const configured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = configured?.apply(this, arguments);
            const reset = restoreInvalidWidgetValues(this);
            if (reset.length) {
                console.warn(`[Multi Stitch Images] restored defaults for ${reset.join(", ")} (saved workflow predates them)`);
            }
            const widget = getWidget(this, "images_json");
            const rawWidget = widget?.value;
            const rawProps = info?.properties?.multi_stitch_images || this.properties?.multi_stitch_images;
            const restored = safeJsonParse(rawWidget);
            const props = safeJsonParse(rawProps);
            // Both sources unreadable: keep the stored text as-is instead of
            // replacing it with "[]", which would destroy a recoverable list on
            // the next save. The backend reports the same input as corrupted.
            const unreadable = restored === null && props === null;
            this._msUnreadable = unreadable ? (rawWidget || rawProps || "") : null;
            const items = restored?.length ? restored : props ?? restored ?? [];
            this._msImages = normalizeItems(items);
            hideWidget(widget);
            hideWidget(getWidget(this, "custom_spacing_color"));
            this._msThumbCache ||= new Map();
            this._msTransformedCache ||= new Map();
            resetHistory(this);
            // Configured moments after a removal with the same id: this is the
            // same node coming back from a graph reload, so its videos and its
            // undo history come with it.
            if (adoptSession(this)) {
                console.debug("[Multi Stitch Images] kept this node's videos and edit history across a graph reload");
            }
            updateCustomColorButton(this);
            syncConditionalWidgets(this);
            if (this._msUnreadable) {
                console.warn(
                    "[Multi Stitch Images] keeping the unreadable image list stored on the node;" +
                    " add or clear images to replace it.",
                );
                updateNodeSize(this);
            } else {
                changed(this);
            }
            scheduleNodeLayout(this);
            return r;
        };

        const serialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (data) {
            serialize?.apply(this, arguments);
            const serialized = this._msUnreadable && !(this._msImages || []).length
                ? this._msUnreadable
                : JSON.stringify(this._msImages || []);
            data.properties ||= {};
            data.properties.multi_stitch_images = serialized;
            const widget = getWidget(this, "images_json");
            if (widget) widget.value = serialized;
        };

        const draw = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            draw?.apply(this, arguments);
            syncConditionalWidgets(this);
            updateNodeSize(this);
            drawThumbs(this, ctx);
            if (!this.flags?.collapsed) drawSizeButton(ctx, this);
        };

        const widgetChanged = nodeType.prototype.onWidgetChanged;
        nodeType.prototype.onWidgetChanged = function (name, value, oldValue, widget) {
            const r = widgetChanged?.apply(this, arguments);
            if (name === "layout_mode" || name === "spacing_color" || name === "match_image_size" || name in ADVANCED_DEFAULTS) {
                syncConditionalWidgets(this);
                scheduleNodeLayout(this);
            }
            // Every setting shows in the preview and the estimate.
            this.graph?.setDirtyCanvas(true, false);
            return r;
        };

        const mouseDown = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function (event, pos, graphCanvas) {
            const primary = event?.button === undefined || event.button === 0;
            if (primary && !this.flags?.collapsed) {
                const [x, y] = localPos(this, event, pos, graphCanvas);
                if (inRect(x, y, sizeButtonRect(this))) {
                    toggleSizePanel(this);
                    stopEvent(event);
                    return true;
                }
                const hit = Object.entries(toolbarControls(this)).find(([, rect]) => inRect(x, y, rect))?.[0];
                if (hit) {
                    if (hit === "add") {
                        if (!cancelUpload(this)) chooseFiles(this);
                    } else if (hit === "clear") clearAllImages(this);
                    else if (hit === "copy") {
                        if (this._msImages?.length) copyStitchedResult(this);
                    } else if (hit === "undo") restoreHistory(this, undoImages);
                    else if (hit === "redo") restoreHistory(this, redoImages);
                    else if (hit === "preview") {
                        if (this._msImages?.length) togglePreview(this);
                    } else if (hit === "options") toggleAdvanced(this);
                    stopEvent(event);
                    return true;
                }
                // With no images yet, the dashed box is the "add" target too.
                if (!listCount(this) && inRect(x, y, emptyBoxRect(this))) {
                    chooseFiles(this);
                    stopEvent(event);
                    return true;
                }
            }
            if (primary && !this.flags?.collapsed && listCount(this)) {
                const [x, y] = localPos(this, event, pos, graphCanvas);
                for (let i = 0; i < (this._msVideos?.length || 0); i++) {
                    const entry = this._msVideos[i];
                    const r = thumbLayout(this, this._msImages.length + i);
                    if (!r.visible || !inRect(x, y, r)) continue;
                    if (inRect(x, y, thumbActionRects(r).remove)) removeVideo(this, entry);
                    else openVideoPicker(this, entry);
                    stopEvent(event);
                    return true;
                }

                for (let i = 0; i < this._msImages.length; i++) {
                    const r = thumbLayout(this, i);
                    if (!r.visible || !inRect(x, y, r)) continue;

                    const actions = thumbActionRects(r);
                    if (inRect(x, y, actions.remove)) {
                        removeImageAt(this, i);
                    } else if (inRect(x, y, actions.prev)) {
                        moveItem(this, i, -1);
                    } else if (inRect(x, y, actions.next)) {
                        moveItem(this, i, 1);
                    } else if (inRect(x, y, actions.drag)) {
                        startThumbnailDrag(this, i, x, y, event, graphCanvas);
                    } else {
                        // Editing no longer competes with reorder gesture detection.
                        // The image area is a direct single-click edit target.
                        openEditor(this, i);
                    }

                    stopEvent(event);
                    return true;
                }
            }
            return mouseDown?.apply(this, arguments) ?? false;
        };

        const extraMenu = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (graphCanvas, options) {
            const r = extraMenu?.apply(this, arguments);
            const index = thumbIndexAt(this, graphCanvas);
            const extra = [];
            const videoIndex = videoIndexAt(this, graphCanvas);
            if (videoIndex >= 0) {
                const entry = this._msVideos[videoIndex];
                extra.push(
                    { content: "Capture frames…", callback: () => openVideoPicker(this, entry) },
                    { content: "Remove video (captured frames stay)", callback: () => removeVideo(this, entry) },
                );
            }
            if (index >= 0) {
                extra.push(
                    {
                        content: `Copy original image #${index + 1}`,
                        callback: () => copyOriginalImage(this, index),
                    },
                    {
                        content: `Replace image #${index + 1}…`,
                        callback: () => replaceImage(this, index),
                    },
                );
            }
            if (this._msImages?.length) {
                extra.push({
                    content: "Copy stitched result",
                    callback: () => copyStitchedResult(this),
                });
            }
            extra.push({
                content: sizePanelEnabled(this) ? "Hide size panel" : "Show size panel (width / height outputs)",
                callback: () => toggleSizePanel(this),
            });
            if (extra.length && Array.isArray(options)) options.unshift(...extra, null);
            return r;
        };

        // A resize by the user keeps its width; the height snaps back to what
        // the rows need.
        const resized = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            const r = resized?.apply(this, arguments);
            if (this._msImages) updateNodeSize(this);
            return r;
        };

        const mouseMove = nodeType.prototype.onMouseMove;
        nodeType.prototype.onMouseMove = function (event, pos, graphCanvas) {
            if (this._msThumbPress) {
                const [x, y] = localPos(this, event, pos, graphCanvas);
                updateThumbnailDrag(this, x, y, event);
                stopEvent(event);
                return true;
            }
            return mouseMove?.apply(this, arguments) ?? false;
        };

        const mouseUp = nodeType.prototype.onMouseUp;
        nodeType.prototype.onMouseUp = function (event, pos, graphCanvas) {
            if (this._msThumbPress) {
                finishThumbnailDrag(this);
                stopEvent(event);
                return true;
            }
            return mouseUp?.apply(this, arguments) ?? false;
        };

        const dragOver = nodeType.prototype.onDragOver;
        nodeType.prototype.onDragOver = function (event) {
            // ComfyUI forwards the drop only when this returns true, and a
            // .mkv or .ts often arrives with an empty MIME type: a dragged
            // file with no type at all still has to be accepted here, or
            // onDragDrop — which takes videos by extension — never runs.
            const accepted = Array.from(event?.dataTransfer?.items || []).some((item) => {
                const type = String(item?.type || "");
                if (type.startsWith("image/") || type.startsWith("video/")) return true;
                return item?.kind === "file" && !type;
            });
            if (accepted) return true;
            return dragOver?.apply(this, arguments) ?? false;
        };

        const dragDrop = nodeType.prototype.onDragDrop;
        nodeType.prototype.onDragDrop = function (event) {
            const files = Array.from(event?.dataTransfer?.files || []).filter((file) => file.type?.startsWith("image/") || isVideoFile(file));
            if (files.length) {
                addFiles(this, files);
                event.preventDefault?.();
                return true;
            }
            return dragDrop?.apply(this, arguments) ?? false;
        };

        const removed = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this._msDisposed = true;
            cancelUpload(this);
            // A removal may be a graph reload in disguise (ComfyUI's Ctrl+Z),
            // so the videos and the edit history are parked for a moment
            // instead of being thrown away. An explicit removal — the card's
            // ×, the picker's Done, Clear, leaving the page — still deletes
            // right away, through its own path.
            stashSession(this);
            this._msVideos = [];
            nodesWithVideos.delete(this);
            this._msPicker?.close(false);
            this._msEditor?.close?.();
            for (const state of this._msThumbCache?.values() || []) state.cancel?.();
            this._msThumbCache?.clear(); this._msTransformedCache?.clear();
            clearTimeout(this._msPreviewRender?.timer);
            this._msPreviewRender = null;
            this._msCopyRender = null;
            detachPressFallback(this._msThumbPress);
            return removed?.apply(this, arguments);
        };
    },
});

// The node's own API. Nothing here is for ComfyUI, which only ever imports
// this file for its side effect; it is what the gallery modal, the DOM view for
// Vue nodes and the tests drive, so both renderings act through exactly the
// functions the canvas UI uses — geometry helpers included, since the DOM view
// and the tests must agree with the canvas about where a card is.
export {
    addFiles,
    advancedOpen,
    advancedState,
    applyImages,
    canRedo,
    canUndo,
    chooseFiles,
    clearAllImages,
    copyStitchedResult,
    drawContained,
    drawPreview,
    drawSizePanel,
    emptyBoxRect,
    listCount,
    listTop,
    moveItem as moveImage,
    nodeWidth,
    notify,
    openEditor,
    openVideoPicker,
    plannedLayout,
    predictedSize,
    previewEnabled,
    previewRect,
    readSettings,
    redo,
    removeImageAt,
    removeVideo,
    sizeButtonRect,
    sizePanelEnabled,
    sizeReadout,
    thumbActionRects,
    thumbLayout,
    titleHeight,
    toggleAdvanced,
    togglePreview,
    toggleSizePanel,
    toolbarControls,
    undo,
};
