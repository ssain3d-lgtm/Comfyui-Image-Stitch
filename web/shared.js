import { api } from "../../scripts/api.js";

export const CROPPED_EPSILON = 0.0005;

export function defaultCrop() {
    return { x: 0, y: 0, w: 1, h: 1 };
}

export function normalizeCrop(crop) {
    const c = crop && typeof crop === "object" ? crop : defaultCrop();
    const x = Math.min(1, Math.max(0, Number(c.x) || 0));
    const y = Math.min(1, Math.max(0, Number(c.y) || 0));
    const w = Math.min(1 - x, Math.max(0.000001, Number(c.w) || 1));
    const h = Math.min(1 - y, Math.max(0.000001, Number(c.h) || 1));
    return { x, y, w, h };
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

export function isCropped(crop) {
    const c = normalizeCrop(crop);
    return Math.abs(c.x) > CROPPED_EPSILON || Math.abs(c.y) > CROPPED_EPSILON ||
        Math.abs(c.w - 1) > CROPPED_EPSILON || Math.abs(c.h - 1) > CROPPED_EPSILON;
}

export function isTransformed(item) {
    const t = normalizeTransform(item);
    return t.rotation !== 0 || t.flip_h || t.flip_v;
}

export function safeJsonParse(value) {
    try {
        const data = JSON.parse(value || "[]");
        return Array.isArray(data) ? data : [];
    } catch (_) {
        return [];
    }
}

export function getWidget(node, name) {
    return node.widgets?.find((widget) => widget.name === name);
}

export function hideWidget(widget) {
    if (!widget) return;

    // ComfyUI has two widget render paths now:
    // - legacy LiteGraph canvas
    // - Vue Nodes / Node 2.0
    //
    // Overriding draw()/computeSize() only hides a widget on the legacy canvas.
    // Vue Nodes intentionally uses options.hidden, so keep both mechanisms.
    // `hidden` is also an accessor backed by options.hidden on current ComfyUI.
    widget._msHidden = true;
    widget.options ||= {};
    widget.options.hidden = true;
    try { widget.hidden = true; } catch (_) {}

    // Legacy-canvas fallback for older ComfyUI builds.
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
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

export function loadThumb(node, item) {
    node._msThumbCache ||= new Map();
    const key = `${item.type || "input"}:${item.subfolder || ""}/${item.filename}`;
    if (node._msThumbCache.has(key)) return node._msThumbCache.get(key);

    const image = new Image();
    const state = { image, ready: false, failed: false };
    node._msThumbCache.set(key, state);
    image.onload = () => {
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

export function renderTransformedImage(source, item) {
    const sw = source.naturalWidth || source.videoWidth || source.width;
    const sh = source.naturalHeight || source.videoHeight || source.height;
    const { rotation, flip_h, flip_v } = normalizeTransform(item);
    const dims = transformedDimensions(sw, sh, item);

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, dims.width);
    canvas.height = Math.max(1, dims.height);
    const ctx = canvas.getContext("2d");

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(flip_h ? -1 : 1, flip_v ? -1 : 1);
    ctx.rotate(rotation * Math.PI / 180);
    ctx.drawImage(source, -sw / 2, -sh / 2, sw, sh);
    ctx.restore();
    return canvas;
}

export function loadTransformedThumb(node, item) {
    const raw = loadThumb(node, item);
    if (!raw.ready || raw.failed) return raw;

    node._msTransformedCache ||= new Map();
    const t = normalizeTransform(item);
    const key = `${item.type || "input"}:${item.subfolder || ""}/${item.filename}:r${t.rotation}:h${t.flip_h ? 1 : 0}:v${t.flip_v ? 1 : 0}`;
    if (node._msTransformedCache.has(key)) return node._msTransformedCache.get(key);

    const state = { image: renderTransformedImage(raw.image, t), ready: true, failed: false };
    node._msTransformedCache.set(key, state);
    return state;
}

function uniqueUploadName(file) {
    const rawExt = (file.name || "image.png").split(".").pop().toLowerCase();
    const ext = /^[a-z0-9]{2,5}$/.test(rawExt) ? rawExt : "png";
    return `multi_stitch_${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${ext}`;
}

export async function uploadFile(file) {
    const uploadName = uniqueUploadName(file);
    const body = new FormData();
    body.append("image", file, uploadName);
    body.append("subfolder", "multi_stitch");
    body.append("type", "input");

    const response = await api.fetchApi("/upload/image", { method: "POST", body });
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
