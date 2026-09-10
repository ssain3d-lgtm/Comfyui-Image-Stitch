// Test harness for the browser extension without ComfyUI.
//
// The extension imports "../../scripts/app.js" and "../../scripts/api.js",
// which under ComfyUI resolve from /extensions/<name>/ to /scripts/. Copying
// web/ into <tmp>/pkg/web/ next to <tmp>/scripts/ reproduces that layout, so
// the files under test are the real ones, unmodified.
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..");

export function stageExtension() {
    const root = mkdtempSync(join(tmpdir(), "ms-web-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    cpSync(join(repoRoot, "web"), join(root, "pkg", "web"), { recursive: true });
    cpSync(join(here, "stubs", "app.js"), join(root, "scripts", "app.js"));
    cpSync(join(here, "stubs", "api.js"), join(root, "scripts", "api.js"));
    return root;
}

function define(name, value) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

// Just enough DOM for the node-side code paths: canvases with a size, an
// Image whose natural size comes from `imageSizes` by filename, transient
// <input> elements, and window listeners the tests can fire by hand.
export function installDom() {
    const listeners = new Map();
    const canvases = [];
    const inputs = [];
    const imageSizes = new Map();
    const noop = () => {};
    const context2d = () => new Proxy({}, {
        get: (target, key) => (key === "measureText" ? () => ({ width: 8 })
            : key === "createLinearGradient" ? () => ({ addColorStop: noop })
                : key === "getImageData" ? () => ({ data: new Uint8ClampedArray(4) })
                    : noop),
        set: () => true,
    });

    define("window", {
        innerWidth: 1600,
        innerHeight: 900,
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(handler);
        },
        removeEventListener(type, handler) {
            listeners.get(type)?.delete(handler);
        },
    });
    define("document", {
        body: {
            appendChild(element) {
                element.attached = true;
                if (element.tag === "input") inputs.push(element);
            },
        },
        createElement(tag) {
            const element = {
                tag,
                style: {},
                width: 0,
                height: 0,
                attached: false,
                handlers: {},
                addEventListener(type, handler) {
                    (element.handlers[type] ||= []).push(handler);
                },
                click: noop,
                remove() {
                    element.attached = false;
                },
                getContext: context2d,
                toBlob(callback, type) {
                    callback({ type: type || "image/png", size: 1, encoded: true });
                },
            };
            if (tag === "canvas") canvases.push(element);
            return element;
        },
        addEventListener: noop,
        removeEventListener: noop,
    });
    define("Image", class {
        set src(url) {
            this.url = url;
            const size = [...imageSizes].find(([name]) => url.includes(name))?.[1];
            setTimeout(() => {
                if (!size) {
                    this.onerror?.();
                    return;
                }
                this.naturalWidth = size[0];
                this.naturalHeight = size[1];
                this.onload?.();
            }, 0);
        }
    });
    define("FormData", class {
        constructor() { this.fields = []; }
        append(key, value, name) { this.fields.push([key, value, name]); }
        entries() { return this.fields[Symbol.iterator](); }
    });
    define("confirm", () => true);
    define("alert", noop);
    define("createImageBitmap", async () => ({ width: 4, height: 4, close: noop }));

    return {
        listeners,
        canvases,
        inputs,
        imageSizes,
        fire(type, event) {
            for (const handler of [...(listeners.get(type) || [])]) handler(event);
        },
        listenerCount(type) {
            return listeners.get(type)?.size || 0;
        },
    };
}

export async function loadExtension(root) {
    const { app } = await import(pathToFileURL(join(root, "scripts", "app.js")).href);
    const api = await import(pathToFileURL(join(root, "scripts", "api.js")).href);
    const shared = await import(pathToFileURL(join(root, "pkg", "web", "shared.js")).href);
    await import(pathToFileURL(join(root, "pkg", "web", "multi_stitch.js")).href);
    const nodeType = { prototype: {} };
    await app.extension.beforeRegisterNodeDef(nodeType, { name: "MultiStitchImages" });
    return { app, api, shared, nodeType };
}

// The widgets INPUT_TYPES declares, in order, with their defaults.
const WIDGET_DEFAULTS = [
    ["direction", "right"], ["match_image_size", false], ["spacing_width", 0],
    ["spacing_color", "white"], ["images_json", "[]"], ["layout_mode", "strip"],
    ["grid_columns", 3], ["custom_spacing_color", "#808080"],
    ["output_limit", "none"], ["output_limit_px", 2048], ["grid_cell_width", 0],
    ["grid_cell_height", 0], ["output_cells", false],
    ["cells_resolution", "placed"], ["minimum_image_side", 0],
];

// A LiteGraph-shaped node with the widgets INPUT_TYPES declares, then run
// through the extension's onNodeCreated exactly as ComfyUI would.
export function makeNode(nodeType, overrides = {}) {
    const node = {
        pos: [0, 0],
        size: [420, 600],
        flags: {},
        properties: {},
        title: "Multi Stitch Images",
        graph: { setDirtyCanvas() {} },
        widgets: WIDGET_DEFAULTS.map(([name, value]) => ({ name, value, options: {} })),
        addWidget(type, name, value, callback) {
            const widget = { type, name, value, callback, options: {} };
            node.widgets.push(widget);
            return widget;
        },
        onWidgetChanged() {},
        setSize(size) {
            node.size = [...size];
        },
        setDirtyCanvas() {},
        inputs: [{ name: "images", link: null }],
        ...overrides,
    };
    nodeType.prototype.onNodeCreated.call(node);
    return node;
}

// A node with the preview band off, so card geometry starts right under the
// widgets (row 0 at y = 118) as the geometry helpers in the tests assume.
export function plainNode(nodeType, overrides = {}) {
    return makeNode(nodeType, { properties: { multi_stitch_preview: false }, ...overrides });
}

// Assigns a list directly (bypassing upload) and gives the node room for it;
// the next layout pass clamps the height to the rows it actually has.
export function setImages(node, items) {
    node._msImages = items;
    node.size = [420, 600];
    node._msSized = true;
}

export const item = (filename, extra = {}) => ({
    filename, type: "input", crop: { x: 0, y: 0, w: 1, h: 1 }, rotation: 0, flip_h: false, flip_v: false, ...extra,
});

export const widget = (node, name) => node.widgets.find((w) => w.name === name);
export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
export const imageFiles = (count, prefix = "img") =>
    Array.from({ length: count }, (_, i) => ({ name: `${prefix}${i}.png`, type: "image/png" }));

// Renders the node through the real onDrawForeground and reports what it
// painted: every string, and how many images were drawn.
export function paintedCalls(nodeType, node) {
    const text = [];
    let drawImage = 0;
    const ctx = new Proxy({}, {
        get: (target, key) => (key === "fillText" ? (value) => text.push(String(value))
            : key === "drawImage" ? () => { drawImage += 1; }
                : key === "measureText" ? () => ({ width: 8 })
                    : key === "createLinearGradient" ? () => ({ addColorStop() {} })
                        : () => {}),
        set: () => true,
    });
    nodeType.prototype.onDrawForeground.call(node, ctx);
    return { text, drawImage };
}

export function paintedText(nodeType, node) {
    return paintedCalls(nodeType, node).text;
}
