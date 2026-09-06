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

export function isCropped(crop) {
    const c = normalizeCrop(crop);
    return Math.abs(c.x) > CROPPED_EPSILON || Math.abs(c.y) > CROPPED_EPSILON ||
        Math.abs(c.w - 1) > CROPPED_EPSILON || Math.abs(c.h - 1) > CROPPED_EPSILON;
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
    // Keep the widget type intact so ComfyUI still serializes its value into the API prompt.
    widget._msHidden = true;
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
    };
}
