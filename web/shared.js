import { api } from "../../scripts/api.js";

export const CROPPED_EPSILON = 0.0005;
// Mirrored by _MAX_IMAGES in multi_stitch.py; a backend test checks they agree.
export const MAX_IMAGES = 256;
// Longest side kept for a thumbnail. Cards are ~130 CSS px wide, so this stays
// crisp on a 2x display at 2x canvas zoom while bounding memory to about
// 1 MiB per image instead of a full-resolution canvas each.
export const THUMB_MAX_SIDE = 512;

export function defaultCrop() {
    return { x: 0, y: 0, w: 1, h: 1 };
}

// Mirrors the backend _normalize_crop, including its collapsed-crop fallback,
// so the node preview can never disagree with the rendered output.
export function normalizeCrop(crop) {
    const c = crop && typeof crop === "object" ? crop : defaultCrop();
    const number = (value, fallback) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    };
    const x = Math.min(Math.max(number(c.x, 0), 0), 1);
    const y = Math.min(Math.max(number(c.y, 0), 0), 1);
    const w = Math.min(Math.max(number(c.w, 1), 0), 1 - x);
    const h = Math.min(Math.max(number(c.h, 1), 0), 1 - y);
    if (w <= 0.000001 || h <= 0.000001) return defaultCrop();
    return { x, y, w, h };
}

// Mirrors the backend _grid_shape: down/up fill column-first, so once rows is
// fixed only ceil(count / rows) columns are actually used.
export function gridShape(count, gridColumns, direction) {
    const n = Math.max(1, Math.floor(Number(count) || 1));
    let cols = Math.max(1, Math.min(Math.floor(Number(gridColumns) || 1), n));
    const rows = Math.ceil(n / cols);
    if (direction === "down" || direction === "up") cols = Math.ceil(n / rows);
    return { rows, cols };
}

export function normalizeTransform(item) {
    const raw = Number(item?.rotation) || 0;
    const rotation = ((Math.round(raw / 90) * 90) % 360 + 360) % 360;
    return {
        rotation,
        flip_h: !!item?.flip_h,
        flip_v: !!item?.flip_v,
    };
}

function rotateCrop(crop, rotation) {
    const { x, y, w, h } = crop;
    if (rotation === 90) return { x: 1 - y - h, y: x, w: h, h: w };
    if (rotation === 180) return { x: 1 - x - w, y: 1 - y - h, w, h };
    if (rotation === 270) return { x: y, y: 1 - x - w, w: h, h: w };
    return { x, y, w, h };
}

// A crop is stored relative to the *transformed* image. renderTransformedImage
// rotates clockwise and then flips, so mapping a crop between the source and a
// view of it follows that order forwards and reverses it backwards. This lets
// the editor carry a crop across a rotate/flip instead of discarding it.
export function cropSourceToView(crop, transform) {
    const t = normalizeTransform(transform);
    let out = rotateCrop(crop, t.rotation);
    if (t.flip_h) out = { ...out, x: 1 - out.x - out.w };
    if (t.flip_v) out = { ...out, y: 1 - out.y - out.h };
    return out;
}

export function cropViewToSource(crop, transform) {
    const t = normalizeTransform(transform);
    let out = { ...crop };
    if (t.flip_v) out = { ...out, y: 1 - out.y - out.h };
    if (t.flip_h) out = { ...out, x: 1 - out.x - out.w };
    return rotateCrop(out, (360 - t.rotation) % 360);
}

export function isCropped(crop) {
    const c = normalizeCrop(crop);
    return Math.abs(c.x) > CROPPED_EPSILON || Math.abs(c.y) > CROPPED_EPSILON ||
        Math.abs(c.w - 1) > CROPPED_EPSILON || Math.abs(c.h - 1) > CROPPED_EPSILON;
}

export function isTransformed(item) {
    const t = normalizeTransform(item);
    return t.rotation !== 0 || t.flip_h || t.flip_v;
}

// Returns null when the value cannot be read as an image list, so callers can
// tell "genuinely empty" from "unreadable" and avoid overwriting the original.
export function safeJsonParse(value) {
    try {
        const data = JSON.parse(value || "[]");
        if (Array.isArray(data)) return data;
        console.warn("[Multi Stitch Images] image list is not an array, ignoring:", value);
        return null;
    } catch (error) {
        console.warn("[Multi Stitch Images] could not parse the image list:", error, value);
        return null;
    }
}

export function getWidget(node, name) {
    return node.widgets?.find((widget) => widget.name === name);
}

// ComfyUI has two widget render paths now:
// - legacy LiteGraph canvas
// - Vue Nodes / Node 2.0
//
// Vue Nodes uses options.hidden; the legacy canvas keeps drawing regardless, so
// draw()/computeSize() must be swapped too. Conditionally shown widgets need
// that swap undone, so record whether the originals were own properties and
// restore them exactly. Every caller goes through here — a second, partial
// implementation is what left grid_columns drawing over the thumbnails.
export function setWidgetHidden(widget, hidden) {
    if (!widget) return;
    widget.options ||= {};
    widget.options.hidden = hidden;
    try { widget.hidden = hidden; } catch (_) {}
    widget._msHidden = hidden;

    if (hidden) {
        widget._msPatched ||= {
            computeSize: Object.prototype.hasOwnProperty.call(widget, "computeSize")
                ? widget.computeSize : null,
            draw: Object.prototype.hasOwnProperty.call(widget, "draw") ? widget.draw : null,
        };
        widget.computeSize = () => [0, -4];
        widget.draw = () => {};
    } else if (widget._msPatched) {
        const original = widget._msPatched;
        if (original.computeSize) widget.computeSize = original.computeSize;
        else delete widget.computeSize;
        if (original.draw) widget.draw = original.draw;
        else delete widget.draw;
        widget._msPatched = null;
    }
    widget.triggerDraw?.();
}

export function hideWidget(widget) {
    setWidgetHidden(widget, true);
}

export function syncImages(node) {
    const serialized = JSON.stringify(node._msImages || []);
    const widget = getWidget(node, "images_json");
    if (widget) widget.value = serialized;
    node.properties ||= {};
    node.properties.multi_stitch_images = serialized;
    node.graph?.setDirtyCanvas(true, true);
}

export function imageUrl(item) {
    const params = new URLSearchParams();
    params.set("filename", item.filename);
    params.set("type", item.type || "input");
    if (item.subfolder) params.set("subfolder", item.subfolder);
    return api.apiURL(`/view?${params.toString()}`);
}

function thumbKey(item) {
    return `${item.type || "input"}:${item.subfolder || ""}/${item.filename}`;
}

// Shrink to at most maxSide on the long edge, halving in steps first: a single
// drawImage() from 4000px down to 500px aliases visibly.
function scaledCanvas(source, width, height, maxSide) {
    let current = source;
    let w = width;
    let h = height;
    while (Math.max(w, h) / 2 >= maxSide) {
        const step = document.createElement("canvas");
        step.width = Math.max(1, Math.round(w / 2));
        step.height = Math.max(1, Math.round(h / 2));
        step.getContext("2d").drawImage(current, 0, 0, step.width, step.height);
        current = step;
        w = step.width;
        h = step.height;
    }
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(width * scale));
    out.height = Math.max(1, Math.round(height * scale));
    out.getContext("2d").drawImage(current, 0, 0, out.width, out.height);
    return out;
}

// Loads a source once and keeps only a bounded copy of it. `width`/`height`
// are the true source size; `image` is the thumbnail-sized canvas. The full
// decode is released as soon as the copy exists, so a node full of large
// images does not pin every original in browser memory.
export function loadThumb(node, item) {
    node._msThumbCache ||= new Map();
    const key = thumbKey(item);
    if (node._msThumbCache.has(key)) return node._msThumbCache.get(key);

    const state = { image: null, width: 0, height: 0, ready: false, failed: false };
    node._msThumbCache.set(key, state);
    const image = new Image();
    image.onload = () => {
        state.width = image.naturalWidth || image.width || 1;
        state.height = image.naturalHeight || image.height || 1;
        state.image = scaledCanvas(image, state.width, state.height, THUMB_MAX_SIDE);
        state.ready = true;
        node.graph?.setDirtyCanvas(true, false);
    };
    image.onerror = () => {
        state.failed = true;
        node.graph?.setDirtyCanvas(true, false);
    };
    image.src = imageUrl(item);
    return state;
}

export function transformedDimensions(width, height, item) {
    const { rotation } = normalizeTransform(item);
    return rotation === 90 || rotation === 270
        ? { width: height, height: width }
        : { width, height };
}

// maxSide > 0 bounds the result's long edge; 0 renders at the source's size,
// which the crop editor needs for pixel-accurate handles.
export function renderTransformedImage(source, item, maxSide = 0) {
    const sw = source.naturalWidth || source.videoWidth || source.width;
    const sh = source.naturalHeight || source.videoHeight || source.height;
    const { rotation, flip_h, flip_v } = normalizeTransform(item);
    const dims = transformedDimensions(sw, sh, item);
    const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(dims.width, dims.height)) : 1;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(dims.width * scale));
    canvas.height = Math.max(1, Math.round(dims.height * scale));
    const ctx = canvas.getContext("2d");

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(flip_h ? -1 : 1, flip_v ? -1 : 1);
    ctx.rotate(rotation * Math.PI / 180);
    ctx.drawImage(source, -sw * scale / 2, -sh * scale / 2, sw * scale, sh * scale);
    ctx.restore();
    return canvas;
}

// One entry per file holding only the current transform, so cycling through
// rotations does not accumulate a canvas per angle. `width`/`height` are the
// true transformed size the resolution estimate needs; `image` is thumbnail
// sized, and an untransformed image reuses the base canvas outright.
export function loadTransformedThumb(node, item) {
    const raw = loadThumb(node, item);
    if (!raw.ready || raw.failed) return raw;

    node._msTransformedCache ||= new Map();
    const t = normalizeTransform(item);
    const transformKey = `r${t.rotation}:h${t.flip_h ? 1 : 0}:v${t.flip_v ? 1 : 0}`;
    const key = thumbKey(item);
    const cached = node._msTransformedCache.get(key);
    if (cached && cached.transformKey === transformKey) return cached;

    const dims = transformedDimensions(raw.width, raw.height, t);
    const identity = t.rotation === 0 && !t.flip_h && !t.flip_v;
    const state = {
        image: identity ? raw.image : renderTransformedImage(raw.image, t, THUMB_MAX_SIDE),
        width: dims.width,
        height: dims.height,
        transformKey,
        ready: true,
        failed: false,
    };
    node._msTransformedCache.set(key, state);
    return state;
}

function uniqueUploadName(file) {
    const rawExt = (file.name || "image.png").split(".").pop().toLowerCase();
    const ext = /^[a-z0-9]{2,5}$/.test(rawExt) ? rawExt : "png";
    return `multi_stitch_${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${ext}`;
}

export async function uploadFile(file, signal) {
    const uploadName = uniqueUploadName(file);
    const body = new FormData();
    body.append("image", file, uploadName);
    body.append("subfolder", "multi_stitch");
    body.append("type", "input");

    const response = await api.fetchApi("/upload/image", { method: "POST", body, signal });
    if (!response.ok) throw new Error(`Image upload failed: ${response.status} ${response.statusText}`);
    const data = await response.json();
    return {
        filename: data.name || uploadName,
        subfolder: data.subfolder || "multi_stitch",
        type: data.type || "input",
        crop: defaultCrop(),
        rotation: 0,
        flip_h: false,
        flip_v: false,
    };
}
