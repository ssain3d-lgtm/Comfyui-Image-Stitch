import { app } from "../../scripts/app.js";
import { openCropEditor } from "./crop_editor.js";
import {
    getWidget,
    gridShape,
    hideWidget,
    imageUrl,
    isCropped,
    isTransformed,
    loadTransformedThumb,
    normalizeCrop,
    normalizeTransform,
    safeJsonParse,
    setWidgetHidden,
    syncImages,
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

function visibleWidgetBottom(node) {
    let bottom = 92;
    for (const widget of node.widgets || []) {
        if (widget._msHidden || widget.hidden || widget.options?.hidden) continue;
        if (Number.isFinite(widget.last_y)) bottom = Math.max(bottom, widget.last_y + 28);
    }
    return bottom;
}

function thumbLayout(node, index) {
    const width = Math.max(MIN_NODE_WIDTH, node.size?.[0] || MIN_NODE_WIDTH);
    const top = visibleWidgetBottom(node) + 26;
    const cellW = (width - 16 - THUMB_GAP * (THUMB_COLS - 1)) / THUMB_COLS;
    const col = index % THUMB_COLS;
    const row = Math.floor(index / THUMB_COLS);
    return {
        x: 8 + col * (cellW + THUMB_GAP),
        y: top + row * (THUMB_HEIGHT + THUMB_GAP),
        w: cellW,
        h: THUMB_HEIGHT,
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

function requiredNodeHeight(node) {
    const count = node._msImages?.length || 0;
    const rows = Math.max(1, Math.ceil(count / THUMB_COLS));
    return visibleWidgetBottom(node) + 26 + rows * THUMB_HEIGHT + (rows - 1) * THUMB_GAP + 12;
}

function updateNodeSize(node, allowShrink = false) {
    if (!node) return;
    const wantedH = requiredNodeHeight(node);
    const width = Math.max(MIN_NODE_WIDTH, node.size?.[0] || 0);
    const currentH = node.size?.[1] || 0;
    const needsExpand = currentH + 1 < wantedH;
    const needsShrink = allowShrink && currentH > wantedH + 2;
    const needsWidth = !node.size || node.size[0] < MIN_NODE_WIDTH;

    if (needsExpand || needsShrink || needsWidth) {
        node.setSize?.([width, needsShrink || needsExpand ? wantedH : currentH]);
        node.graph?.setDirtyCanvas(true, true);
    }
}

function scheduleNodeLayout(node, allowShrink = true) {
    if (!node || node._msLayoutScheduled) return;
    node._msLayoutScheduled = true;
    const run = () => {
        node._msLayoutScheduled = false;
        syncConditionalWidgets(node);
        updateNodeSize(node, allowShrink);
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
    const size = mediaSize(state.image);
    const c = normalizeCrop(item.crop);
    return {
        w: Math.max(1, Math.round(size.w * c.w)),
        h: Math.max(1, Math.round(size.h * c.h)),
    };
}

function predictedSize(node) {
    const items = node._msImages || [];
    if (!items.length) return null;

    const dims = [];
    let skipped = 0;
    for (const item of items) {
        // A file that failed to load is left out of the estimate rather than
        // suppressing it for every other image; one still decoding just means
        // "not yet", and the next repaint tries again.
        if (loadTransformedThumb(node, item).failed) {
            skipped++;
            continue;
        }
        const d = transformedCropDims(node, item);
        if (!d) return null;
        dims.push(d);
    }
    if (!dims.length) return null;

    const direction = getWidget(node, "direction")?.value || "right";
    const match = !!getWidget(node, "match_image_size")?.value;
    const spacing = Math.max(0, Number(getWidget(node, "spacing_width")?.value) || 0);
    const layout = getWidget(node, "layout_mode")?.value || "strip";

    if (layout === "grid") {
        const requested = Math.max(1, Math.min(16, Number(getWidget(node, "grid_columns")?.value) || 3));
        const { rows, cols } = gridShape(dims.length, requested, direction);
        let cellW, cellH;
        if (match) {
            cellW = dims[0].w;
            cellH = dims[0].h;
        } else {
            cellW = Math.max(...dims.map((d) => d.w));
            cellH = Math.max(...dims.map((d) => d.h));
        }
        return {
            w: cols * cellW + spacing * (cols - 1),
            h: rows * cellH + spacing * (rows - 1),
            skipped,
        };
    }

    if (match && dims.length > 1) {
        const first = dims[0];
        for (let i = 1; i < dims.length; i++) {
            const d = dims[i];
            if (direction === "left" || direction === "right") {
                d.w = Math.max(1, Math.round(d.w * first.h / d.h));
                d.h = first.h;
            } else {
                d.h = Math.max(1, Math.round(d.h * first.w / d.w));
                d.w = first.w;
            }
        }
    }

    return direction === "left" || direction === "right"
        ? {
            w: dims.reduce((s, d) => s + d.w, 0) + spacing * (dims.length - 1),
            h: Math.max(...dims.map((d) => d.h)),
            skipped,
        }
        : {
            w: Math.max(...dims.map((d) => d.w)),
            h: dims.reduce((s, d) => s + d.h, 0) + spacing * (dims.length - 1),
        };
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
            ? `${count} image${count === 1 ? "" : "s"}${predicted ? `  •  ~${predicted.w}×${predicted.h}${predicted.skipped ? ` (${predicted.skipped} not loaded)` : ""}` : ""}  •  click image edit / drag ≡ reorder`
            : node._msUnreadable
                ? "Image list unreadable — kept as-is. Add or Clear all to replace."
                : "Select this node, then Ctrl+V images",
        9,
        top + 12,
    );

    if (!count) {
        const r = thumbLayout(node, 0);
        ctx.strokeStyle = "#666";
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.setLineDash([]);
        ctx.fillStyle = "#8f8f8f";
        ctx.textAlign = "center";
        ctx.fillText("Paste / Drop / Add images", r.x + r.w / 2, r.y + r.h / 2 + 4);
        ctx.restore();
        return;
    }

    items.forEach((item, index) => {
        const r = thumbLayout(node, index);
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
            ctx.fillStyle = "#8d8d8d";
            ctx.textAlign = "center";
            ctx.fillText(state.failed ? "Load failed" : "Loading…", r.x + r.w / 2, r.y + r.h / 2 + 4);
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
    });

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
        if (inRect(x, y, thumbLayout(node, i))) return i;
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
    syncImages(node);
    syncConditionalWidgets(node);
    updateNodeSize(node, true);
    scheduleNodeLayout(node, true);
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
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < node._msImages.length; i++) {
        const r = thumbLayout(node, i);
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

async function addFiles(node, files) {
    const images = Array.from(files || []).filter((file) => file && file.type?.startsWith("image/"));
    if (!images.length) return;
    if (node._msUploading) {
        // Uploads run sequentially and can take seconds, so say why nothing
        // happened rather than swallowing the paste.
        notify(
            "Upload in progress",
            `Still uploading — ${images.length} image(s) were not added. Try again in a moment.`,
            "warn",
        );
        return;
    }

    node._msUploading = true;
    const originalTitle = node.title;
    node.title = "Multi Stitch Images • uploading…";
    node.graph?.setDirtyCanvas(true, true);

    try {
        for (const file of images) {
            node._msImages.push(await uploadFile(file));
            changed(node);
        }
    } catch (error) {
        console.error("[Multi Stitch Images]", error);
        alert(`Multi Stitch Images\n${error?.message || error}`);
    } finally {
        node._msUploading = false;
        node.title = originalTitle || "Multi Stitch Images";
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
    setWidgetVisible(getWidget(node, "grid_columns"), layout === "grid");
    setWidgetVisible(getWidget(node, "custom_color_picker"), spacingColor === "custom");
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
    if (!node._msImages?.[index]) return;
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
    if (press.dragging) press.target = nearestThumbIndex(node, x, y);
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

    if (!node.widgets?.some((w) => w.name === "Add images…")) {
        const add = node.addWidget("button", "Add images…", null, () => chooseFiles(node));
        add.serialize = false;

        const clear = node.addWidget("button", "Clear all", null, () => {
            if (!node._msImages.length || confirm(`Remove all ${node._msImages.length} images from this node?`)) {
                node._msImages = [];
                node._msThumbCache.clear();
                node._msTransformedCache.clear();
                changed(node);
            }
        });
        clear.serialize = false;

        const picker = node.addWidget("button", "custom_color_picker", null, () => chooseCustomColor(node));
        picker.serialize = false;
    }

    updateCustomColorButton(node);
    syncConditionalWidgets(node);
    node.pasteFiles = (files) => addFiles(node, files);
    changed(node);
    scheduleNodeLayout(node, true);
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
            updateCustomColorButton(this);
            syncConditionalWidgets(this);
            if (this._msUnreadable) {
                console.warn(
                    "[Multi Stitch Images] keeping the unreadable image list stored on the node;" +
                    " add or clear images to replace it.",
                );
                updateNodeSize(this, true);
            } else {
                changed(this);
            }
            scheduleNodeLayout(this, true);
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
            updateNodeSize(this, false);
            drawThumbs(this, ctx);
        };

        const widgetChanged = nodeType.prototype.onWidgetChanged;
        nodeType.prototype.onWidgetChanged = function (name, value, oldValue, widget) {
            const r = widgetChanged?.apply(this, arguments);
            if (name === "layout_mode" || name === "spacing_color") {
                syncConditionalWidgets(this);
                scheduleNodeLayout(this, true);
            }
            return r;
        };

        const mouseDown = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function (event, pos, graphCanvas) {
            const primary = event?.button === undefined || event.button === 0;
            if (primary && !this.flags?.collapsed && this._msImages?.length) {
                const [x, y] = localPos(this, event, pos, graphCanvas);

                for (let i = 0; i < this._msImages.length; i++) {
                    const r = thumbLayout(this, i);
                    if (!inRect(x, y, r)) continue;

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
                    null,
                );
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
            detachPressFallback(this._msThumbPress);
            return removed?.apply(this, arguments);
        };
    },
});
