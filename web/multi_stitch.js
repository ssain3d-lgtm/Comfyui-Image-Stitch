import { app } from "../../scripts/app.js";
import { openCropEditor } from "./crop_editor.js";
import {
    commitImages,
    cropPixelBox,
    getWidget,
    hideWidget,
    historyOf,
    imageUrl,
    isCropped,
    isTransformed,
    layoutPlacements,
    limitedSize,
    loadTransformedThumb,
    MAX_IMAGES,
    normalizeCrop,
    normalizeTransform,
    redoImages,
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
// The composed-result preview band above the list, and the list itself:
// three rows by default, scrollable beyond that, resizable by the user.
const PREVIEW_HEIGHT = 150;
const DEFAULT_LIST_ROWS = 3;
const SCROLLBAR_W = 8;
const ROW_H = THUMB_HEIGHT + THUMB_GAP;
const NAMED_COLORS = { white: "#ffffff", black: "#000000", red: "#ff0000", green: "#00ff00", blue: "#0000ff" };

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

function previewRect(node) {
    if (!previewEnabled(node) || !(node._msImages?.length)) return null;
    return { x: 8, y: visibleWidgetBottom(node) + 26, w: nodeWidth(node) - 16, h: PREVIEW_HEIGHT };
}

function listTop(node) {
    const preview = previewRect(node);
    return preview ? preview.y + preview.h + 8 : visibleWidgetBottom(node) + 26;
}

function rowsOf(node) {
    return Math.max(1, Math.ceil((node._msImages?.length || 0) / THUMB_COLS));
}

function heightForRows(node, rows) {
    return listTop(node) + rows * ROW_H - THUMB_GAP + 12;
}

// The visible window onto the thumbnail rows: how many fit in the node's
// current height, and which row is scrolled to the top.
function listViewport(node) {
    const top = listTop(node);
    const rows = rowsOf(node);
    const available = (node.size?.[1] || 0) - top - 12;
    const visibleRows = Math.max(1, Math.min(rows, Math.floor((available + THUMB_GAP) / ROW_H)));
    const maxScroll = Math.max(0, rows - visibleRows);
    const scroll = Math.max(0, Math.min(maxScroll, Math.floor(node._msScrollRow || 0)));
    node._msScrollRow = scroll;
    return {
        top, rows, visibleRows, maxScroll, scroll,
        height: visibleRows * ROW_H - THUMB_GAP,
        scrollable: maxScroll > 0,
    };
}

function scrollbarRect(node, viewport = listViewport(node)) {
    if (!viewport.scrollable) return null;
    return { x: nodeWidth(node) - 8 - SCROLLBAR_W, y: viewport.top, w: SCROLLBAR_W, h: viewport.height };
}

function scrollList(node, deltaRows) {
    const viewport = listViewport(node);
    const next = Math.max(0, Math.min(viewport.maxScroll, viewport.scroll + deltaRows));
    if (next === viewport.scroll) return false;
    node._msScrollRow = next;
    node.graph?.setDirtyCanvas(true, false);
    return true;
}

function thumbLayout(node, index) {
    const viewport = listViewport(node);
    const width = nodeWidth(node) - 16 - (viewport.scrollable ? SCROLLBAR_W + 6 : 0);
    const cellW = (width - THUMB_GAP * (THUMB_COLS - 1)) / THUMB_COLS;
    const col = index % THUMB_COLS;
    const row = Math.floor(index / THUMB_COLS) - viewport.scroll;
    return {
        x: 8 + col * (cellW + THUMB_GAP),
        y: viewport.top + row * ROW_H,
        w: cellW,
        h: THUMB_HEIGHT,
        visible: row >= 0 && row < viewport.visibleRows,
    };
}

// Undo / redo / preview controls at the right end of the status line.
function headerControls(node) {
    const y = visibleWidgetBottom(node) + 6;
    const right = nodeWidth(node) - 8;
    return {
        preview: { x: right - 64, y, w: 64, h: 18 },
        redo: { x: right - 64 - 4 - 24, y, w: 24, h: 18 },
        undo: { x: right - 64 - 4 - 24 - 4 - 24, y, w: 24, h: 18 },
    };
}

function thumbActionRects(r) {
    return {
        remove: { x: r.x + r.w - 23, y: r.y + 3, w: 20, h: 19 },
        prev: { x: r.x + 3, y: r.y + r.h - 22, w: 20, h: 19 },
        drag: { x: r.x + r.w / 2 - 13, y: r.y + r.h - 22, w: 26, h: 19 },
        next: { x: r.x + r.w - 23, y: r.y + r.h - 22, w: 20, h: 19 },
    };
}



function updateNodeSize(node) {
    if (!node) return;
    const width = nodeWidth(node);
    const rows = rowsOf(node);
    const top = listTop(node);
    node.size ||= [width, 0];

    // Keep the same rows visible when the widgets above the list, or the
    // preview band, change height.
    if (node._msListTop !== undefined && top !== node._msListTop) node.size[1] += top - node._msListTop;
    node._msListTop = top;

    let height = node.size[1] || 0;
    if (!node._msSized) {
        height = heightForRows(node, Math.min(rows, DEFAULT_LIST_ROWS));
        node._msSized = true;
    }
    // Never shorter than one row, never taller than all the rows.
    height = Math.max(heightForRows(node, 1), Math.min(heightForRows(node, rows), height));

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
        spacing: Math.max(0, Number(value("spacing_width", 0)) || 0),
        layout: value("layout_mode", "strip"),
        gridColumns: Math.max(1, Math.min(16, Number(value("grid_columns", 3)) || 3)),
        cellWidth: Math.max(0, Number(value("grid_cell_width", 0)) || 0),
        cellHeight: Math.max(0, Number(value("grid_cell_height", 0)) || 0),
        outputLimit: value("output_limit", "none"),
        outputLimitPx: Math.max(1, Number(value("output_limit_px", 2048)) || 2048),
        spacingColor: value("spacing_color", "white"),
        customColor: normalizeHex(value("custom_spacing_color", "#808080")),
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
    let layout;
    try {
        layout = layoutPlacements(
            dims, settings.layout, settings.direction, settings.match,
            settings.gridColumns, settings.spacing, settings.cellWidth, settings.cellHeight,
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

function drawPill(ctx, rect, label, active = true) {
    ctx.fillStyle = active ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.05)";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = active ? "#e8e8e8" : "#6f6f6f";
    ctx.textAlign = "center";
    ctx.fillText(label, rect.x + rect.w / 2, rect.y + 13);
    ctx.textAlign = "left";
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
    planned.placements.forEach((p, index) => {
        const dest = { x: ox + p.x * scale, y: oy + p.y * scale, w: Math.max(1, p.w * scale), h: Math.max(1, p.h * scale) };
        const state = loadTransformedThumb(node, items[index]);
        if (state.ready && !planned.failed[index]) {
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
    ctx.fillText(caption, rect.x + 8, rect.y + rect.h - 5);
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
            ctx.fillText("Load failed", r.x + r.w / 2, r.y + r.h / 2 - 4);
            ctx.fillText("click to relink", r.x + r.w / 2, r.y + r.h / 2 + 12);
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

function drawThumbs(node, ctx) {
    if (node.flags?.collapsed) return;

    const items = node._msImages || [];
    const count = items.length;
    const top = visibleWidgetBottom(node) + 8;

    ctx.save();
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "#b8b8b8";
    const predicted = predictedSize(node);
    ctx.fillText(
        count
            ? `${count} image${count === 1 ? "" : "s"}${predicted ? `  •  ~${predicted.w}×${predicted.h}${predicted.skipped ? ` (${predicted.skipped} not loaded)` : ""}` : ""}${imageInputConnected(node) ? "  + IMAGE input" : ""}`
            : node._msUnreadable
                ? "Image list unreadable — kept as-is. Add or Clear all to replace."
                : "Select this node, then Ctrl+V images",
        9,
        top + 12,
    );

    const history = historyOf(node);
    const controls = headerControls(node);
    drawPill(ctx, controls.undo, "↶", history.past.length > 0);
    drawPill(ctx, controls.redo, "↷", history.future.length > 0);
    drawPill(ctx, controls.preview, previewEnabled(node) ? "Preview ✓" : "Preview", count > 0);

    if (!count) {
        const r = thumbLayout(node, 0);
        ctx.strokeStyle = "#666";
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.setLineDash([]);
        ctx.fillStyle = "#8f8f8f";
        ctx.textAlign = "center";
        ctx.fillText("Paste / Drop / Add images", r.x + r.w / 2, r.y + r.h / 2 - 4);
        ctx.fillText("click an image to edit · drag ≡ to reorder", r.x + r.w / 2, r.y + r.h / 2 + 12);
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
    ctx.restore();

    const bar = scrollbarRect(node, viewport);
    if (bar) {
        ctx.fillStyle = "rgba(255,255,255,.08)";
        ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
        const trackH = bar.h - 2 * 14;
        const thumbH = Math.max(12, trackH * (viewport.visibleRows / viewport.rows));
        const thumbY = bar.y + 14 + (trackH - thumbH) * (viewport.scroll / viewport.maxScroll);
        ctx.fillStyle = "rgba(255,255,255,.35)";
        ctx.fillRect(bar.x + 1, thumbY, bar.w - 2, thumbH);
        ctx.fillStyle = "#ddd";
        ctx.textAlign = "center";
        ctx.fillText("▴", bar.x + bar.w / 2, bar.y + 11);
        ctx.fillText("▾", bar.x + bar.w / 2, bar.y + bar.h - 4);
        ctx.textAlign = "left";
        ctx.fillStyle = "#9a9a9a";
        ctx.fillText(
            `rows ${viewport.scroll + 1}–${Math.min(viewport.rows, viewport.scroll + viewport.visibleRows)} of ${viewport.rows}`,
            9,
            viewport.top + viewport.height + 10,
        );
    }
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

function stopEvent(event, graphCanvas) {
    if (graphCanvas) graphCanvas._mouse_down_widget = true;
    try {
        event?.preventDefault?.();
        event?.stopPropagation?.();
    } catch (_) {}
}

function changed(node) {
    // A real edit replaces whatever unreadable text was preserved on load.
    node._msUnreadable = null;
    commitImages(node);
    syncConditionalWidgets(node);
    updateNodeSize(node);
    scheduleNodeLayout(node);
}

function restoreHistory(node, step) {
    if (!step(node)) return false;
    node._msUnreadable = null;
    node._msTransformedCache?.clear();
    syncConditionalWidgets(node);
    updateNodeSize(node);
    scheduleNodeLayout(node);
    return true;
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
            node._msThumbCache?.clear();
            node._msTransformedCache?.clear();
            Object.assign(item, { filename: uploaded.filename, subfolder: uploaded.subfolder, type: uploaded.type });
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
    if (target < 0 || target >= node._msImages.length) return;
    const [item] = node._msImages.splice(index, 1);
    node._msImages.splice(target, 0, item);
    changed(node);
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

function syncUploadUi(node, baseTitle) {
    const run = node._msUpload;
    const button = getWidget(node, "Add images…");
    if (run) {
        node.title = `${baseTitle || "Multi Stitch Images"} • uploading ${run.done}/${run.total}…`;
        if (button) button.label = `Cancel upload (${run.done}/${run.total})`;
    } else if (button) {
        button.label = button.name;
    }
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

async function addFiles(node, files) {
    const images = Array.from(files || []).filter((file) => file && file.type?.startsWith("image/"));
    if (!images.length) return;
    if (node._msUpload) {
        // Uploads run sequentially and can take seconds, so say why nothing
        // happened rather than swallowing the paste.
        const run = node._msUpload;
        notify(
            "Upload in progress",
            `Still uploading (${run.done}/${run.total}) — ${images.length} image(s) were not added. ` +
            "Wait for it, or click Cancel upload.",
            "warn",
        );
        return;
    }

    // The backend refuses more than MAX_IMAGES at run time; refusing here
    // saves uploading files that could never be used.
    const remaining = MAX_IMAGES - (node._msImages?.length || 0);
    if (remaining <= 0) {
        notify(
            "Image limit reached",
            `This node holds at most ${MAX_IMAGES} images. Remove some before adding more.`,
            "warn",
        );
        return;
    }
    let queue = images;
    if (queue.length > remaining) {
        notify(
            "Image limit",
            `Only ${remaining} more image${remaining === 1 ? "" : "s"} fit (max ${MAX_IMAGES}); ` +
            `${queue.length - remaining} skipped.`,
            "warn",
        );
        queue = queue.slice(0, remaining);
    }

    node._msUploadGeneration = (node._msUploadGeneration || 0) + 1;
    const run = {
        generation: node._msUploadGeneration,
        abort: new AbortController(),
        total: queue.length,
        done: 0,
    };
    node._msUpload = run;
    const originalTitle = node.title;
    syncUploadUi(node, originalTitle);

    try {
        for (const file of queue) {
            const item = await uploadFile(file, run.abort.signal);
            // Clear all or Cancel upload ran during the await: the file is on
            // disk, but it must not reappear on a list the user just reset.
            if (node._msUploadGeneration !== run.generation) break;
            node._msImages.push(item);
            run.done += 1;
            changed(node);
            syncUploadUi(node, originalTitle);
        }
    } catch (error) {
        if (error?.name !== "AbortError") {
            console.error("[Multi Stitch Images]", error);
            notify("Upload failed", String(error?.message || error), "error");
        }
    } finally {
        if (node._msUpload === run) node._msUpload = null;
        node.title = originalTitle || "Multi Stitch Images";
        syncUploadUi(node, originalTitle);
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

function chooseFiles(node) {
    const { input, removeOnce } = transientInput("file");
    input.accept = "image/*";
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
    const outputLimit = getWidget(node, "output_limit")?.value || "none";
    setWidgetVisible(getWidget(node, "grid_columns"), layout === "grid");
    setWidgetVisible(getWidget(node, "grid_cell_width"), layout === "grid");
    setWidgetVisible(getWidget(node, "grid_cell_height"), layout === "grid");
    setWidgetVisible(getWidget(node, "output_limit_px"), outputLimit !== "none");
    setWidgetVisible(getWidget(node, "custom_color_picker"), spacingColor === "custom");
    setWidgetVisible(getWidget(node, "cells_resolution"), !!getWidget(node, "output_cells")?.value);
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
    // A file that cannot be loaded cannot be edited; offer to relink instead.
    if (loadTransformedThumb(node, item).failed) {
        replaceImage(node, index);
        return;
    }
    node._msEditorOpening = true;
    Promise.resolve(openCropEditor(node, index))
        .catch((error) => {
            console.error("[Multi Stitch Images] crop editor", error);
            alert(error?.message || error);
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

function finishThumbnailDrag(node, graphCanvas) {
    const press = node?._msThumbPress;
    if (!press || press.finished) return false;

    press.finished = true;
    detachPressFallback(press);
    node._msThumbPress = null;

    if (press.dragging) reorderItem(node, press.index, press.target);

    node.graph?.setDirtyCanvas(true, false);
    if (graphCanvas) graphCanvas._mouse_down_widget = false;
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
        setTimeout(() => finishThumbnailDrag(node, graphCanvas), 0);
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

function setupNode(node) {
    node._msDisposed = false;
    node.previewMediaType = "image";
    node.properties ||= {};

    const imagesWidget = getWidget(node, "images_json");
    hideWidget(imagesWidget);
    const colorWidget = getWidget(node, "custom_spacing_color");
    hideWidget(colorWidget);

    const fromWidget = safeJsonParse(imagesWidget?.value);
    const fromProps = safeJsonParse(node.properties.multi_stitch_images);
    node._msImages = normalizeItems(fromWidget?.length ? fromWidget : fromProps ?? fromWidget);
    node._msThumbCache = new Map();
    node._msTransformedCache = new Map();
    node._msScrollRow = 0;
    resetHistory(node);

    if (!node.widgets?.some((w) => w.name === "Add images…")) {
        // The same button cancels a running upload; its label says which.
        const add = node.addWidget("button", "Add images…", null, () => {
            if (!cancelUpload(node)) chooseFiles(node);
        });
        add.serialize = false;

        const clear = node.addWidget("button", "Clear all", null, () => {
            const count = node._msImages.length;
            if (count && !confirm(`Remove all ${count} images from this node?`)) return;
            cancelUpload(node);
            node._msImages = [];
            node._msThumbCache.clear();
            node._msTransformedCache.clear();
            changed(node);
        });
        clear.serialize = false;

        const picker = node.addWidget("button", "custom_color_picker", null, () => chooseCustomColor(node));
        picker.serialize = false;
    }

    updateCustomColorButton(node);
    syncConditionalWidgets(node);
    node.pasteFiles = (files) => addFiles(node, files);
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
            this._msScrollRow = 0;
            // The saved node size is the user's; only clamp it from here on.
            this._msSized = true;
            this._msListTop = undefined;
            resetHistory(this);
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
        };

        const widgetChanged = nodeType.prototype.onWidgetChanged;
        nodeType.prototype.onWidgetChanged = function (name, value, oldValue, widget) {
            const r = widgetChanged?.apply(this, arguments);
            if (name === "layout_mode" || name === "spacing_color" || name === "output_limit" || name === "output_cells") {
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
                const controls = headerControls(this);
                if (inRect(x, y, controls.undo) || inRect(x, y, controls.redo) || inRect(x, y, controls.preview)) {
                    if (inRect(x, y, controls.undo)) restoreHistory(this, undoImages);
                    else if (inRect(x, y, controls.redo)) restoreHistory(this, redoImages);
                    else if (this._msImages?.length) togglePreview(this);
                    stopEvent(event, graphCanvas);
                    return true;
                }
            }
            if (primary && !this.flags?.collapsed && this._msImages?.length) {
                const [x, y] = localPos(this, event, pos, graphCanvas);
                const viewport = listViewport(this);
                const bar = scrollbarRect(this, viewport);
                if (bar && inRect(x, y, bar)) {
                    if (y < bar.y + 14) scrollList(this, -1);
                    else if (y > bar.y + bar.h - 14) scrollList(this, 1);
                    else {
                        // Track click: page towards the click.
                        const trackH = bar.h - 28;
                        const thumbCentre = bar.y + 14 + (trackH * ((viewport.scroll + viewport.visibleRows / 2) / viewport.rows));
                        scrollList(this, y < thumbCentre ? -viewport.visibleRows : viewport.visibleRows);
                    }
                    stopEvent(event, graphCanvas);
                    return true;
                }

                for (let i = 0; i < this._msImages.length; i++) {
                    const r = thumbLayout(this, i);
                    if (!r.visible || !inRect(x, y, r)) continue;

                    const actions = thumbActionRects(r);
                    if (inRect(x, y, actions.remove)) {
                        this._msImages.splice(i, 1);
                        this._msThumbCache?.clear();
                        this._msTransformedCache?.clear();
                        changed(this);
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

                    stopEvent(event, graphCanvas);
                    return true;
                }
            }
            return mouseDown?.apply(this, arguments) ?? false;
        };

        const extraMenu = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (graphCanvas, options) {
            const r = extraMenu?.apply(this, arguments);
            const index = thumbIndexAt(this, graphCanvas);
            if (index >= 0 && Array.isArray(options)) {
                options.unshift(
                    {
                        content: `Copy original image #${index + 1}`,
                        callback: () => copyOriginalImage(this, index),
                    },
                    {
                        content: `Replace image #${index + 1}…`,
                        callback: () => replaceImage(this, index),
                    },
                    null,
                );
            }
            return r;
        };

        // Wheel over the list scrolls it when there is more than fits.
        const mouseWheel = nodeType.prototype.onMouseWheel;
        nodeType.prototype.onMouseWheel = function (event, pos, graphCanvas) {
            if (!this.flags?.collapsed && this._msImages?.length) {
                const [x, y] = localPos(this, event, pos, graphCanvas);
                const viewport = listViewport(this);
                if (viewport.scrollable && y >= viewport.top && y <= viewport.top + viewport.height && x >= 0 && x <= nodeWidth(this)) {
                    const delta = Number(event?.deltaY) || Number(event?.wheelDelta) * -1 || 0;
                    if (delta !== 0) {
                        scrollList(this, delta > 0 ? 1 : -1);
                        stopEvent(event, graphCanvas);
                        return true;
                    }
                }
            }
            return mouseWheel?.apply(this, arguments) ?? false;
        };

        // A resize by the user changes how many rows are visible; keep it in range.
        const resized = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            const r = resized?.apply(this, arguments);
            if (this._msImages) {
                this._msSized = true;
                updateNodeSize(this);
            }
            return r;
        };

        const mouseMove = nodeType.prototype.onMouseMove;
        nodeType.prototype.onMouseMove = function (event, pos, graphCanvas) {
            if (this._msThumbPress) {
                const [x, y] = localPos(this, event, pos, graphCanvas);
                updateThumbnailDrag(this, x, y, event);
                stopEvent(event, graphCanvas);
                return true;
            }
            return mouseMove?.apply(this, arguments) ?? false;
        };

        const mouseUp = nodeType.prototype.onMouseUp;
        nodeType.prototype.onMouseUp = function (event, pos, graphCanvas) {
            if (this._msThumbPress) {
                finishThumbnailDrag(this, graphCanvas);
                stopEvent(event, graphCanvas);
                return true;
            }
            return mouseUp?.apply(this, arguments) ?? false;
        };

        const dragOver = nodeType.prototype.onDragOver;
        nodeType.prototype.onDragOver = function (event) {
            if (Array.from(event?.dataTransfer?.items || []).some((item) => item.type?.startsWith("image/"))) {
                return true;
            }
            return dragOver?.apply(this, arguments) ?? false;
        };

        const dragDrop = nodeType.prototype.onDragDrop;
        nodeType.prototype.onDragDrop = function (event) {
            const files = Array.from(event?.dataTransfer?.files || []).filter((file) => file.type?.startsWith("image/"));
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
            for (const state of this._msThumbCache?.values() || []) state.cancel?.();
            this._msThumbCache?.clear(); this._msTransformedCache?.clear();
            detachPressFallback(this._msThumbPress);
            return removed?.apply(this, arguments);
        };
    },
});
