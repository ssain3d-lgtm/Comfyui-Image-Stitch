// Node-side behaviour of the extension: paste, upload limits and cancellation,
// reorder, save/restore, thumbnails and the copy action. Runs the real
// web/*.js files against the stubs in ./stubs — see harness.mjs.
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import {
    imageFiles, installDom, loadExtension, makeNode, paintedText, stageExtension, tick, widget,
} from "./harness.mjs";

const dom = installDom();
let app, api, shared, nodeType;

before(async () => {
    ({ app, api, shared, nodeType } = await loadExtension(stageExtension()));
});

beforeEach(() => {
    app.extensionManager.toast.log.length = 0;
    api.uploads.length = 0;
    api.knobs.delayMs = 0;
    dom.imageSizes.clear();
});

const toasts = () => app.extensionManager.toast.log.map((t) => `${t.severity}/${t.summary}`);
const card = (index) => {
    // Mirrors thumbLayout(): 3 columns of 130px under a 92px widget block.
    const col = index % 3;
    const row = Math.floor(index / 3);
    return { x: 8 + col * 137, y: 118 + row * 99, w: 130, h: 92 };
};
const pointer = (x, y, client = [x, y]) => ({
    button: 0, canvasX: x, canvasY: y, clientX: client[0], clientY: client[1],
    preventDefault() {}, stopPropagation() {},
});

describe("paste and upload", () => {
    it("uploads pasted images and mirrors the list into the widget and properties", async () => {
        const node = makeNode(nodeType);
        assert.equal(typeof node.pasteFiles, "function");
        assert.equal(node.previewMediaType, "image");

        await node.pasteFiles(imageFiles(2));
        assert.equal(api.uploads.length, 2);
        assert.equal(node._msImages.length, 2);
        const json = widget(node, "images_json").value;
        assert.equal(node.properties.multi_stitch_images, json);
        const [first] = JSON.parse(json);
        assert.deepEqual(Object.keys(first).sort(), ["crop", "filename", "flip_h", "flip_v", "rotation", "subfolder", "type"]);
        assert.equal(node.title, "Multi Stitch Images");
    });

    it("ignores files that are not images", async () => {
        const node = makeNode(nodeType);
        await node.pasteFiles([{ name: "notes.txt", type: "text/plain" }]);
        assert.equal(api.uploads.length, 0);
        assert.equal(node._msImages.length, 0);
    });

    it("refuses a paste while an upload is running, and says so", async () => {
        const node = makeNode(nodeType);
        api.knobs.delayMs = 10;
        const running = node.pasteFiles(imageFiles(2, "slow"));
        await tick(2);
        await node.pasteFiles(imageFiles(1, "racing"));
        assert.deepEqual(toasts(), ["warn/Upload in progress"]);
        await running;
        assert.equal(node._msImages.length, 2);
    });

    it("stops at MAX_IMAGES instead of uploading files the backend would refuse", async () => {
        const node = makeNode(nodeType);
        await node.pasteFiles(imageFiles(shared.MAX_IMAGES + 44));
        assert.equal(node._msImages.length, shared.MAX_IMAGES);
        assert.equal(api.uploads.length, shared.MAX_IMAGES);
        assert.deepEqual(toasts(), ["warn/Image limit"]);

        app.extensionManager.toast.log.length = 0;
        await node.pasteFiles(imageFiles(1, "extra"));
        assert.equal(node._msImages.length, shared.MAX_IMAGES);
        assert.deepEqual(toasts(), ["warn/Image limit reached"]);
    });

    it("shows progress, and the Add button cancels while keeping what already landed", async () => {
        const node = makeNode(nodeType);
        const add = widget(node, "Add images…");
        api.knobs.delayMs = 20;
        const running = node.pasteFiles(imageFiles(5, "c"));
        await tick(50);
        assert.match(add.label, /^Cancel upload \(\d\/5\)$/);
        assert.match(node.title, /uploading \d\/5…$/);

        add.callback();
        await running;
        assert.ok(node._msImages.length >= 1 && node._msImages.length < 5, `kept ${node._msImages.length}`);
        assert.equal(node._msImages.length, api.uploads.length, "every upload that finished is on the node");
        assert.equal(add.label, "Add images…");
        assert.equal(node.title, "Multi Stitch Images");
        assert.equal(node._msUpload, null);
        assert.deepEqual(toasts(), [], "a cancel is not an error");
    });

    it("Clear all during an upload cancels it and nothing reappears afterwards", async () => {
        const node = makeNode(nodeType);
        api.knobs.delayMs = 15;
        const running = node.pasteFiles(imageFiles(4, "k"));
        await tick(40);
        widget(node, "Clear all").callback();
        assert.equal(node._msImages.length, 0);
        await running;
        await tick(60);
        assert.equal(node._msImages.length, 0);
        assert.equal(widget(node, "images_json").value, "[]");
    });

    it("reports an upload failure through a toast instead of throwing", async () => {
        const node = makeNode(nodeType);
        api.knobs.failNext = true;
        await node.pasteFiles(imageFiles(2, "f"));
        assert.deepEqual(toasts(), ["error/Upload failed"]);
        assert.equal(node._msUpload, null);
        assert.equal(node.title, "Multi Stitch Images");
    });

    it("accepts image drops and rejects other drags", () => {
        const node = makeNode(nodeType);
        assert.equal(nodeType.prototype.onDragOver.call(node, { dataTransfer: { items: [{ type: "image/png" }] } }), true);
        assert.equal(nodeType.prototype.onDragOver.call(node, { dataTransfer: { items: [{ type: "text/plain" }] } }), false);
    });
});

describe("reorder", () => {
    it("moves a card by its ≡ handle through window events only, then releases every listener", async () => {
        const node = makeNode(nodeType);
        let captureCalls = 0;
        node.captureInput = () => { captureCalls += 1; };
        node._msImages = imageFiles(4).map((f) => ({ filename: f.name, type: "input", crop: { x: 0, y: 0, w: 1, h: 1 }, rotation: 0, flip_h: false, flip_v: false }));

        const handle = { x: card(0).x + 65, y: card(0).y + 92 - 12 };
        const consumed = nodeType.prototype.onMouseDown.call(node, pointer(handle.x, handle.y, [100, 200]), [handle.x, handle.y], {});
        assert.equal(consumed, true);
        assert.ok(node._msThumbPress, "a press is recorded");
        assert.equal(dom.listenerCount("pointermove"), 1);

        // The pointer leaves the node: only window sees the move.
        const target = { x: card(2).x + 65, y: card(2).y + 46 };
        dom.fire("pointermove", pointer(target.x, target.y, [400, 400]));
        assert.equal(node._msThumbPress.dragging, true);
        assert.equal(node._msThumbPress.target, 2);

        dom.fire("pointerup", {});
        await tick(5);
        assert.equal(node._msThumbPress, null);
        assert.deepEqual(node._msImages.map((i) => i.filename), ["img1.png", "img2.png", "img0.png", "img3.png"]);
        assert.equal(dom.listenerCount("pointermove"), 0);
        assert.equal(dom.listenerCount("pointerup"), 0);
        assert.equal(captureCalls, 0, "the deprecated captureInput is no longer used");
    });

    it("lets a right-click through to the context menu instead of treating it as a click", () => {
        const node = makeNode(nodeType);
        node._msImages = [{ filename: "a.png", type: "input", crop: { x: 0, y: 0, w: 1, h: 1 }, rotation: 0, flip_h: false, flip_v: false }];
        const consumed = nodeType.prototype.onMouseDown.call(node, { ...pointer(card(0).x + 40, card(0).y + 40), button: 2 }, null, {});
        assert.equal(consumed, false, "not handled, so LiteGraph opens its menu");
        assert.ok(!node._msThumbPress, "the right button never starts a drag");
        assert.ok(!node._msEditorOpening, "and never opens the editor");
    });
});

describe("save and restore", () => {
    const items = () => [
        { filename: "a.png", subfolder: "multi_stitch", type: "input", crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, rotation: 90, flip_h: true, flip_v: false },
        { filename: "b.png", subfolder: "multi_stitch", type: "input", crop: { x: 0, y: 0, w: 1, h: 1 }, rotation: 0, flip_h: false, flip_v: true },
    ];

    it("round-trips the image list through onSerialize and onConfigure", () => {
        const node = makeNode(nodeType);
        node._msImages = items();
        const data = { properties: {} };
        nodeType.prototype.onSerialize.call(node, data);
        const saved = data.properties.multi_stitch_images;
        assert.deepEqual(JSON.parse(saved), items());

        // LiteGraph restores widget values and properties, then calls onConfigure.
        const reopened = makeNode(nodeType);
        widget(reopened, "images_json").value = saved;
        reopened.properties.multi_stitch_images = saved;
        nodeType.prototype.onConfigure.call(reopened, { properties: { multi_stitch_images: saved } });
        assert.deepEqual(reopened._msImages, items());
        assert.equal(reopened._msUnreadable, null);
    });

    it("keeps an unreadable list verbatim instead of saving [] over it", () => {
        const broken = '[{"filename":"a.png"';
        const node = makeNode(nodeType);
        widget(node, "images_json").value = broken;
        node.properties.multi_stitch_images = broken;
        nodeType.prototype.onConfigure.call(node, { properties: { multi_stitch_images: broken } });
        assert.equal(node._msImages.length, 0);
        assert.equal(node._msUnreadable, broken);
        assert.equal(widget(node, "images_json").value, broken, "onConfigure did not overwrite it");

        const data = { properties: {} };
        nodeType.prototype.onSerialize.call(node, data);
        assert.equal(data.properties.multi_stitch_images, broken, "onSerialize wrote the original back");
        assert.match(paintedText(nodeType, node)[0], /unreadable/);

        // The first real edit replaces it.
        node._msImages.push(items()[0]);
        widget(node, "Clear all").callback();
        assert.equal(widget(node, "images_json").value, "[]");
        assert.equal(node._msUnreadable, null);
    });

    it("drops entries without a filename, as the backend does", () => {
        const node = makeNode(nodeType);
        const raw = JSON.stringify([{ filename: "ok.png" }, 1, null, { crop: {} }, { filename: "" }]);
        widget(node, "images_json").value = raw;
        nodeType.prototype.onConfigure.call(node, { properties: {} });
        assert.deepEqual(node._msImages.map((i) => i.filename), ["ok.png"]);
    });
});

describe("thumbnails and the resolution estimate", () => {
    const item = (filename, extra = {}) => ({ filename, type: "input", crop: { x: 0, y: 0, w: 1, h: 1 }, rotation: 0, flip_h: false, flip_v: false, ...extra });

    it("keeps a bounded canvas per image but estimates from the true size", async () => {
        const node = makeNode(nodeType);
        dom.imageSizes.set("big.png", [4000, 3000]);
        node._msImages = [item("big.png", { rotation: 90 })];
        shared.loadTransformedThumb(node, node._msImages[0]);
        await tick(2);

        const base = [...node._msThumbCache.values()][0];
        assert.deepEqual([base.width, base.height], [4000, 3000]);
        assert.ok(Math.max(base.image.width, base.image.height) <= shared.THUMB_MAX_SIDE);

        const rotated = shared.loadTransformedThumb(node, node._msImages[0]);
        assert.deepEqual([rotated.width, rotated.height], [3000, 4000]);
        assert.ok(Math.max(rotated.image.width, rotated.image.height) <= shared.THUMB_MAX_SIDE);

        for (const rotation of [180, 270, 0]) {
            node._msImages[0].rotation = rotation;
            shared.loadTransformedThumb(node, node._msImages[0]);
        }
        assert.equal(node._msTransformedCache.size, 1, "only the current transform is cached");
        assert.equal(shared.loadTransformedThumb(node, node._msImages[0]).image, base.image, "identity reuses the base canvas");

        paintedText(nodeType, node);
        assert.match(paintedText(nodeType, node)[0], /~4000×3000/);
    });

    it("leaves a file that failed to load out of the estimate instead of hiding it", async () => {
        const node = makeNode(nodeType);
        dom.imageSizes.set("a.png", [60, 40]);
        dom.imageSizes.set("b.png", [60, 40]);
        node._msImages = [item("a.png"), item("b.png"), item("missing.png")];
        widget(node, "layout_mode").value = "grid";
        widget(node, "direction").value = "down";
        paintedText(nodeType, node);
        await tick(2);
        const header = paintedText(nodeType, node)[0];
        assert.match(header, /3 images/);
        assert.match(header, /~120×40 \(1 not loaded\)/);
    });
});

describe("conditional widgets", () => {
    it("hides grid_columns on the legacy canvas in strip mode and restores it for grid", () => {
        const node = makeNode(nodeType);
        const columns = widget(node, "grid_columns");
        assert.equal(columns.options.hidden, true);
        assert.deepEqual(columns.computeSize(), [0, -4]);

        widget(node, "layout_mode").value = "grid";
        nodeType.prototype.onWidgetChanged.call(node, "layout_mode", "grid", "strip", widget(node, "layout_mode"));
        assert.equal(columns.options.hidden, false);
        assert.equal(Object.prototype.hasOwnProperty.call(columns, "computeSize"), false, "the override is gone, not replaced by undefined");
    });
});

describe("copy original image", () => {
    const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

    it("offers the entry only over a card and copies the file as PNG", async () => {
        const node = makeNode(nodeType);
        node._msImages = [{ filename: "photo.jpg", type: "input", crop: { x: 0, y: 0, w: 1, h: 1 }, rotation: 0, flip_h: false, flip_v: false }];
        const written = [];
        define("fetch", async () => ({ ok: true, status: 200, blob: async () => ({ type: "image/jpeg" }) }));
        define("ClipboardItem", class { constructor(parts) { this.parts = parts; } });
        define("navigator", { clipboard: { async write(items) { written.push(await items[0].parts["image/png"]); } } });

        const off = [];
        nodeType.prototype.getExtraMenuOptions.call(node, { graph_mouse: [card(0).x + 65, card(0).y - 30] }, off);
        assert.equal(off.length, 0);

        const options = [];
        nodeType.prototype.getExtraMenuOptions.call(node, { graph_mouse: [card(0).x + 65, card(0).y + 46] }, options);
        assert.equal(options[0].content, "Copy original image #1");
        await options[0].callback();
        assert.equal(written.length, 1);
        assert.equal(written[0].type, "image/png", "a JPEG source is re-encoded");
        assert.deepEqual(toasts(), ["success/Copied"]);
    });

    it("reports a missing file instead of throwing", async () => {
        const node = makeNode(nodeType);
        node._msImages = [{ filename: "gone.png", type: "input", crop: { x: 0, y: 0, w: 1, h: 1 }, rotation: 0, flip_h: false, flip_v: false }];
        define("fetch", async () => ({ ok: false, status: 404, statusText: "Not Found" }));
        const options = [];
        nodeType.prototype.getExtraMenuOptions.call(node, { graph_mouse: [card(0).x + 65, card(0).y + 46] }, options);
        await options[0].callback();
        assert.deepEqual(toasts(), ["error/Copy failed"]);
    });
});
