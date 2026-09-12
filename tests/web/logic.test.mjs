// Node-side behaviour of the extension: paste, upload limits and cancellation,
// reorder, save/restore, thumbnails and the copy action. Runs the real
// web/*.js files against the stubs in ./stubs — see harness.mjs.
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import {
    imageFiles, installDom, item, loadExtension, makeNode, paintedCalls, paintedText, plainNode, setImages,
    stageExtension, tick, videoFile, widget,
} from "./harness.mjs";

const dom = installDom();
let app, api, shared, picker, nodeType;

before(async () => {
    ({ app, api, shared, picker, nodeType } = await loadExtension(stageExtension()));
});

beforeEach(() => {
    app.extensionManager.toast.log.length = 0;
    api.uploads.length = 0;
    api.uploadTargets.length = 0;
    api.calls.length = 0;
    api.knobs.delayMs = 0;
    dom.imageSizes.clear();
});

const toasts = () => app.extensionManager.toast.log.map((t) => `${t.severity}/${t.summary}`);
// Row 0 of the list on a node with the preview off: the 92px widget block,
// the status line and the 24px toolbar sit above it (toolbarRect/listTop).
const LIST_TOP = 148;
const card = (index) => {
    // Mirrors thumbLayout(): 3 columns of 130px under the toolbar.
    const col = index % 3;
    const row = Math.floor(index / 3);
    return { x: 8 + col * 137, y: LIST_TOP + row * 99, w: 130, h: 92 };
};
const pointer = (x, y, client = [x, y]) => ({
    button: 0, canvasX: x, canvasY: y, clientX: client[0], clientY: client[1],
    preventDefault() {}, stopPropagation() {},
});

async function waitForThumbs(node) {
    for (let i = 0; i < 100; i++) {
        if ([...(node._msThumbCache?.values() || [])].every(state => state.ready || state.failed)) return;
        await tick(2);
    }
    assert.fail("thumbnail queue did not settle");
}

// Toolbar pills under the status line, y 120..140 on a 420px node:
// add x 8..72, clear 76..124, copy 128..184, undo 188..212, redo 216..240,
// preview 244..314, options 318..402.
const control = {
    add: [40, 130], clear: [100, 130], copy: [156, 130], undo: [200, 130], redo: [228, 130],
    preview: [279, 130], options: [360, 130],
};
const click = (node, [x, y]) => nodeType.prototype.onMouseDown.call(node, pointer(x, y), [x, y], {});
const until = async (condition, ms = 2000) => {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > ms) assert.fail("timed out waiting");
        await tick(2);
    }
};

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

    it("shows progress, and the Add pill cancels while keeping what already landed", async () => {
        const node = makeNode(nodeType);
        api.knobs.delayMs = 20;
        const running = node.pasteFiles(imageFiles(5, "c"));
        await tick(50);
        assert.ok(paintedText(nodeType, node).some((t) => /^Cancel \d\/5$/.test(t)), "the Add pill turns into Cancel");
        assert.match(node.title, /uploading \d\/5…$/);

        assert.equal(click(node, control.add), true);
        await running;
        assert.ok(node._msImages.length >= 1 && node._msImages.length < 5, `kept ${node._msImages.length}`);
        assert.equal(node._msImages.length, api.uploads.length, "every upload that finished is on the node");
        assert.ok(paintedText(nodeType, node).includes("+ Add"), "the pill is Add again");
        assert.equal(node.title, "Multi Stitch Images");
        assert.equal(node._msUpload, null);
        assert.deepEqual(toasts(), [], "a cancel is not an error");
    });

    it("Clear during an upload cancels it and nothing reappears afterwards", async () => {
        const node = makeNode(nodeType);
        api.knobs.delayMs = 15;
        const running = node.pasteFiles(imageFiles(4, "k"));
        await tick(40);
        click(node, control.clear);
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
        const node = plainNode(nodeType);
        let captureCalls = 0;
        node.captureInput = () => { captureCalls += 1; };
        setImages(node, imageFiles(4).map((f) => item(f.name)));

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
        const node = plainNode(nodeType);
        setImages(node, [item("a.png")]);
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
        click(node, control.clear);
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
    it("keeps a bounded canvas per image but estimates from the true size", async () => {
        const node = plainNode(nodeType);
        dom.imageSizes.set("big.png", [4000, 3000]);
        setImages(node, [item("big.png", { rotation: 90 })]);
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
        const node = plainNode(nodeType);
        dom.imageSizes.set("a.png", [60, 40]);
        dom.imageSizes.set("b.png", [60, 40]);
        setImages(node, [item("a.png"), item("b.png"), item("missing.png")]);
        widget(node, "layout_mode").value = "grid";
        widget(node, "direction").value = "down";
        paintedText(nodeType, node);
        await waitForThumbs(node);
        const header = paintedText(nodeType, node)[0];
        assert.match(header, /3 images/);
        // The missing file keeps its slot, stood in for by the first known size,
        // so the layout matches what relinking it will produce.
        assert.match(header, /~180×40 \(1 not loaded\)/);
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

    it("folds every advanced option by default and, once opened, shows only the relevant ones", () => {
        const node = makeNode(nodeType);
        const advanced = ["output_limit", "output_limit_px", "grid_cell_width", "grid_cell_height", "output_cells", "cells_resolution", "minimum_image_side"];
        for (const name of advanced) assert.equal(widget(node, name).options.hidden, true, `${name} starts folded`);

        assert.equal(click(node, control.options), true);
        assert.equal(widget(node, "output_limit").options.hidden, false);
        assert.equal(widget(node, "output_cells").options.hidden, false);
        assert.equal(widget(node, "minimum_image_side").options.hidden, false);
        assert.equal(widget(node, "grid_cell_width").options.hidden, true, "cell size needs grid");
        assert.equal(widget(node, "grid_cell_height").options.hidden, true);
        assert.equal(widget(node, "output_limit_px").options.hidden, true, "the pixel cap needs a limit");
        assert.equal(widget(node, "cells_resolution").options.hidden, true, "cell resolution needs the cells output");

        widget(node, "layout_mode").value = "grid";
        nodeType.prototype.onWidgetChanged.call(node, "layout_mode", "grid", "strip", widget(node, "layout_mode"));
        assert.equal(widget(node, "grid_cell_width").options.hidden, false);
        assert.equal(widget(node, "grid_cell_height").options.hidden, false);

        widget(node, "output_limit").value = "max_width";
        nodeType.prototype.onWidgetChanged.call(node, "output_limit", "max_width", "none", widget(node, "output_limit"));
        assert.equal(widget(node, "output_limit_px").options.hidden, false);

        widget(node, "output_cells").value = true;
        nodeType.prototype.onWidgetChanged.call(node, "output_cells", true, false, widget(node, "output_cells"));
        assert.equal(widget(node, "cells_resolution").options.hidden, false);
    });
});

describe("toolbar and folded options", () => {
    it("spends the widget rows of a fresh node on five settings and no buttons", () => {
        const node = makeNode(nodeType);
        const shown = node.widgets.filter((w) => !w.options.hidden).map((w) => w.name);
        assert.deepEqual(shown, ["direction", "match_image_size", "spacing_width", "spacing_color", "layout_mode"]);
        assert.deepEqual(node.widgets.filter((w) => w.type === "button").map((w) => w.name), ["custom_color_picker"]);
        const painted = paintedText(nodeType, node);
        for (const label of ["+ Add", "Clear", "⧉ Copy", "↶", "↷", "Preview ✓", "Options ▸"]) {
            assert.ok(painted.includes(label), `${label} is on the toolbar`);
        }
    });

    it("keeps a non-default option visible while folded and counts it on the pill", () => {
        const node = makeNode(nodeType);
        widget(node, "output_limit").value = "max_width";
        nodeType.prototype.onWidgetChanged.call(node, "output_limit", "max_width", "none", widget(node, "output_limit"));
        assert.equal(widget(node, "output_limit").options.hidden, false, "a value that changes the output stays on the node");
        assert.equal(widget(node, "output_limit_px").options.hidden, true, "its dependent keeps the default, so it stays folded");
        assert.ok(paintedText(nodeType, node).includes("Options ▸ (1)"));

        widget(node, "output_limit_px").value = 512;
        nodeType.prototype.onWidgetChanged.call(node, "output_limit_px", 512, 2048, widget(node, "output_limit_px"));
        assert.equal(widget(node, "output_limit_px").options.hidden, false);
        assert.ok(paintedText(nodeType, node).includes("Options ▸ (2)"));

        assert.equal(click(node, control.options), true);
        assert.equal(node.properties.multi_stitch_advanced, true);
        assert.ok(paintedText(nodeType, node).includes("Options ▾"));
        assert.equal(widget(node, "minimum_image_side").options.hidden, false);
        click(node, control.options);
        assert.equal(node.properties.multi_stitch_advanced, false);
        assert.equal(widget(node, "minimum_image_side").options.hidden, true);
        assert.equal(widget(node, "output_limit_px").options.hidden, false, "still non-default, still shown");
    });

    it("opens the file picker from the Add pill and from the empty box", () => {
        const node = plainNode(nodeType);
        dom.inputs.length = 0;
        assert.equal(click(node, control.add), true);
        assert.equal(dom.inputs.length, 1);
        assert.equal(dom.inputs[0].accept, "image/*,video/*");
        assert.equal(dom.inputs[0].multiple, true);

        assert.equal(click(node, [card(0).x + 60, card(0).y + 40]), true);
        assert.equal(dom.inputs.length, 2, "the dashed box is an add target too");
        for (const input of dom.inputs) input.remove();

        // Copy and Preview do nothing on an empty node; Clear asks nothing.
        assert.equal(click(node, control.copy), true);
        assert.ok(!node._msCopying);
        assert.equal(click(node, control.preview), true);
        assert.equal(node.properties.multi_stitch_preview, false, "unchanged");
        assert.equal(dom.inputs.length, 2, "no picker from the other pills");
    });
});

describe("empty box", () => {
    it("spans the list width and keeps its hint inside", () => {
        const node = plainNode(nodeType);
        dom.inputs.length = 0;
        // The right end of the list, past the first grid cell: still the add target.
        assert.equal(click(node, [420 - 8 - 10, LIST_TOP + 40]), true);
        assert.equal(dom.inputs.length, 1, "the dashed box is as wide as the list");
        assert.equal(click(node, [420 - 8 + 4, LIST_TOP + 40]), false, "but stops at the list's edge");
        assert.equal(dom.inputs.length, 1);
        for (const input of dom.inputs) input.remove();

        // 7px per character: the full hint fits a 404px box.
        const wide = paintedCalls(nodeType, node, { measure: (t) => t.length * 7 }).text;
        assert.ok(wide.includes("Paste / Drop / Add images or a video"));
        assert.ok(wide.includes("click an image to edit · drag ≡ to reorder"));

        // 11px per character: the full hint would run past the box, so a shorter one is drawn.
        const narrow = paintedCalls(nodeType, node, { measure: (t) => t.length * 11 }).text;
        assert.ok(narrow.includes("Paste / Drop / Add images"));
        assert.ok(!narrow.includes("Paste / Drop / Add images or a video"));
        assert.ok(narrow.includes("click to edit · drag ≡ to reorder"));
        assert.ok(!narrow.includes("click an image to edit · drag ≡ to reorder"));
    });

    it("shortens the size panel's hint the same way", () => {
        const node = plainNode(nodeType);
        node.properties.multi_stitch_size_panel = true;
        // 8.5px per character: the long hint (57 chars) is wider than the 372px box, the middle one fits.
        const narrow = paintedCalls(nodeType, node, { measure: (t) => t.length * 8.5 }).text;
        assert.ok(narrow.includes("Add an image for the width / height outputs"));
        assert.ok(!narrow.some((t) => /its size becomes/.test(t)));
    });
});

describe("preview", () => {
    it("draws every image into the band and reports the final size after the output cap", async () => {
        const node = makeNode(nodeType);
        dom.imageSizes.set("a.png", [40, 20]);
        dom.imageSizes.set("b.png", [20, 20]);
        setImages(node, [item("a.png"), item("b.png")]);
        widget(node, "output_limit").value = "max_width";
        widget(node, "output_limit_px").value = 30;
        paintedCalls(nodeType, node);
        await waitForThumbs(node);
        const painted = paintedCalls(nodeType, node);
        // strip/right/match: 40x20 + 20x20 = 60x20 canvas, capped to 30 wide.
        assert.match(painted.text[0], /2 images {2}• {2}~30×10/);
        assert.ok(painted.text.some((t) => t === "Preview  30×10  (canvas 60×20)"), painted.text.join(" | "));
        assert.equal(painted.drawImage, 4, "two images in the preview and two thumbnails");
    });

    it("toggles from the toolbar and gives the rows the band's height back", async () => {
        const node = makeNode(nodeType);
        dom.imageSizes.set("a.png", [40, 20]);
        setImages(node, [item("a.png")]);
        paintedCalls(nodeType, node);
        await waitForThumbs(node);
        const before = node.size[1];
        assert.equal(click(node, control.preview), true);
        assert.equal(node.properties.multi_stitch_preview, false);
        assert.equal(node.size[1], before - (150 + 8));
        const painted = paintedCalls(nodeType, node);
        assert.ok(!painted.text.some((t) => t.startsWith("Preview  ")));
        assert.equal(painted.drawImage, 1, "only the thumbnail now");

        click(node, control.preview);
        assert.equal(node.properties.multi_stitch_preview, true);
        assert.equal(node.size[1], before);
    });

    it("mentions a connected IMAGE input, whose frames only exist at run time", async () => {
        const node = makeNode(nodeType, { inputs: [{ name: "images", link: 7 }] });
        dom.imageSizes.set("a.png", [40, 20]);
        setImages(node, [item("a.png")]);
        paintedCalls(nodeType, node);
        await waitForThumbs(node);
        const painted = paintedCalls(nodeType, node);
        assert.match(painted.text[0], /\+ IMAGE input$/);
        assert.ok(painted.text.some((t) => t.endsWith("+ IMAGE input at run time")));
    });
});

describe("sharp preview", () => {
    const bitmapOf = (node) => node._msPreviewRender?.canvas;

    it("keeps the thumbnails while they fit, and redraws from the original once they would stretch", async () => {
        const node = makeNode(nodeType);
        dom.imageSizes.set("big.png", [4000, 2000]);
        setImages(node, [item("big.png")]);
        paintedCalls(nodeType, node);
        await waitForThumbs(node);

        // At 1:1 the 4000px image is drawn 276px wide from a 512px thumbnail.
        paintedCalls(nodeType, node);
        assert.equal(node._msPreviewRender, undefined, "no render while the thumbnail is not upscaled");

        // Zoomed in three times it would be 828px wide: render from the file.
        let painted = paintedCalls(nodeType, node, { pixelScale: 3 });
        const render = node._msPreviewRender;
        assert.ok(render && !render.ready, "a render is scheduled");
        assert.equal(painted.drawImage, 2, "meanwhile the thumbnail still fills the band");
        dom.canvases.length = 0;
        await until(() => render.ready);
        // 828 rounds up to 1024 wide; the bitmap keeps the composite's aspect.
        const bitmap = bitmapOf(node);
        assert.deepEqual([bitmap.width, bitmap.height], [1024, 512]);
        assert.equal(bitmap.draws, 1, "the original was drawn into it once");
        // 4000 → 1024 is below one half: one halving step before the final draw.
        assert.equal(dom.canvases.length, 2, "reduced through an intermediate canvas, not in one drawImage");

        painted = paintedCalls(nodeType, node, { pixelScale: 3 });
        assert.ok(painted.sources.includes(bitmap), "the band now draws the sharp bitmap");
        assert.equal(painted.drawImage, 2, "bitmap plus the card thumbnail, no thumbnail in the band");
        assert.equal(node._msPreviewRender, render, "the same size reuses the cache");
    });

    it("drops the bitmap when the layout changes, but shows it through a zoom step", async () => {
        const node = makeNode(nodeType);
        dom.imageSizes.set("big.png", [2000, 1000]);
        setImages(node, [item("big.png")]);
        paintedCalls(nodeType, node);
        await waitForThumbs(node);
        paintedCalls(nodeType, node, { pixelScale: 3 });
        await until(() => node._msPreviewRender.ready);
        const first = bitmapOf(node);

        // A zoom step needs a bigger bitmap: the old one stays on screen meanwhile.
        let painted = paintedCalls(nodeType, node, { pixelScale: 5 });
        assert.notEqual(node._msPreviewRender.key.split("|")[1], "1024x512");
        assert.equal(node._msPreviewRender.previous, first);
        assert.ok(painted.sources.includes(first));
        await until(() => node._msPreviewRender.ready);
        assert.deepEqual([bitmapOf(node).width, bitmapOf(node).height], [1536, 768]);

        // A layout change makes the pixels wrong: back to thumbnails until re-rendered.
        widget(node, "spacing_width").value = 8;
        painted = paintedCalls(nodeType, node, { pixelScale: 5 });
        assert.equal(node._msPreviewRender.previous, null);
        assert.ok(!painted.sources.includes(first));
        assert.equal(painted.drawImage, 2, "thumbnail in the band again");
        await until(() => node._msPreviewRender.ready);
        assert.ok(paintedCalls(nodeType, node, { pixelScale: 5 }).sources.includes(bitmapOf(node)));
    });

    it("abandons a pending render when the node is removed", async () => {
        const node = makeNode(nodeType);
        dom.imageSizes.set("big.png", [2000, 1000]);
        setImages(node, [item("big.png")]);
        paintedCalls(nodeType, node);
        await waitForThumbs(node);
        paintedCalls(nodeType, node, { pixelScale: 3 });
        assert.ok(node._msPreviewRender);
        nodeType.prototype.onRemoved.call(node);
        assert.equal(node._msPreviewRender, null);
        dom.canvases.length = 0;
        await tick(250);
        assert.equal(dom.canvases.length, 0, "nothing was rendered after removal");
    });
});

describe("undo and redo", () => {
    it("steps back through adds, forward again, and forgets the future after a new edit", async () => {
        const node = plainNode(nodeType);
        await node.pasteFiles(imageFiles(2, "u"));
        assert.equal(node._msImages.length, 2);
        assert.equal(node._msHistory.past.length, 2, "one entry per upload");

        assert.equal(click(node, control.undo), true);
        assert.equal(node._msImages.length, 1);
        click(node, control.undo);
        assert.equal(node._msImages.length, 0);
        assert.equal(widget(node, "images_json").value, "[]", "the widget follows the undo");
        click(node, control.undo);
        assert.equal(node._msImages.length, 0, "nothing further to undo");

        click(node, control.redo);
        assert.equal(node._msImages.length, 1);
        await node.pasteFiles(imageFiles(1, "v"));
        assert.equal(node._msHistory.future.length, 0, "a new edit discards the redo branch");
        click(node, control.redo);
        assert.equal(node._msImages.length, 2);
    });

    it("undoes a drag reorder and a Clear", async () => {
        const node = plainNode(nodeType);
        setImages(node, imageFiles(3).map((f) => item(f.name)));
        node._msCommitted = JSON.stringify(node._msImages);
        const handle = { x: card(0).x + 65, y: card(0).y + 92 - 12 };
        nodeType.prototype.onMouseDown.call(node, pointer(handle.x, handle.y, [100, 200]), [handle.x, handle.y], {});
        dom.fire("pointermove", pointer(card(2).x + 65, card(2).y + 46, [400, 400]));
        dom.fire("pointerup", {});
        await tick(5);
        assert.deepEqual(node._msImages.map((i) => i.filename), ["img1.png", "img2.png", "img0.png"]);
        click(node, control.undo);
        assert.deepEqual(node._msImages.map((i) => i.filename), ["img0.png", "img1.png", "img2.png"]);

        click(node, control.clear);
        assert.equal(node._msImages.length, 0);
        click(node, control.undo);
        assert.equal(node._msImages.length, 3);
    });

    it("starts a fresh history when a workflow is loaded into the node", () => {
        const node = plainNode(nodeType);
        node._msHistory.past.push("[]");
        const saved = JSON.stringify([item("a.png")]);
        widget(node, "images_json").value = saved;
        nodeType.prototype.onConfigure.call(node, { properties: { multi_stitch_images: saved } });
        assert.equal(node._msHistory.past.length, 0);
        assert.equal(node._msHistory.future.length, 0);
    });
});

describe("list height", () => {
    const rowsTall = (rows) => LIST_TOP + rows * 99 - 7 + 12;

    it("grows with the rows and keeps every card clickable", () => {
        const node = plainNode(nodeType);
        node._msImages = imageFiles(12).map((f) => item(f.name));   // four rows
        paintedCalls(nodeType, node);
        assert.equal(node.size[1], rowsTall(4), "four rows tall");

        // Card 9 opens row 3, which a three-row list used to keep off-screen:
        // its × sits at the top right of the 130px cell.
        const removeX = 8 + 130 - 23 + 10;
        const removeY = LIST_TOP + 3 * 99 + 3 + 9;
        assert.equal(click(node, [removeX, removeY]), true);
        assert.equal(node._msImages.length, 11);
        assert.equal(node._msImages.some((i) => i.filename === "img9.png"), false);
        assert.equal(node.size[1], rowsTall(4), "eleven images still fill four rows");

        node._msImages.splice(9);
        paintedCalls(nodeType, node);
        assert.equal(node.size[1], rowsTall(3), "nine images shrink the node to three rows");
    });

    it("snaps a user resize back to the natural height", () => {
        const node = plainNode(nodeType);
        setImages(node, imageFiles(12).map((f) => item(f.name)));
        node.size = [420, 5000];
        nodeType.prototype.onResize.call(node, node.size);
        assert.equal(node.size[1], rowsTall(4), "no taller than the four rows");
        node.size = [300, 50];
        nodeType.prototype.onResize.call(node, node.size);
        assert.deepEqual(node.size, [420, rowsTall(4)], "no narrower than the minimum, and the height is not the user's");
    });

    it("has no wheel handler of its own", () => {
        assert.equal(nodeType.prototype.onMouseWheel, undefined, "the wheel stays ComfyUI's, for zooming");
    });
});

describe("relink a missing image", () => {
    it("replaces the file while keeping crop, transform and position", async () => {
        const node = plainNode(nodeType);
        dom.imageSizes.set("a.png", [40, 20]);
        dom.imageSizes.set("c.png", [40, 20]);
        setImages(node, [item("a.png"), item("gone.png", { crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, rotation: 90 }), item("c.png")]);
        paintedCalls(nodeType, node);
        await waitForThumbs(node);
        assert.match(paintedText(nodeType, node)[0], /\(1 not loaded\)/);

        // Clicking the failed card offers a file instead of the editor.
        dom.inputs.length = 0;
        assert.equal(click(node, [card(1).x + 60, card(1).y + 50]), true);
        assert.equal(node._msEditorOpening, undefined, "the editor was not opened");
        const input = dom.inputs.at(-1);
        assert.ok(input?.attached, "a file picker was opened");
        input.files = [{ name: "found.png", type: "image/png" }];
        await input.handlers.change[0]();

        const names = node._msImages.map((i) => i.filename);
        assert.equal(names[0], "a.png");
        assert.equal(names[2], "c.png");
        assert.match(names[1], /^multi_stitch_.*\.png$/, "uploaded under the node's naming scheme");
        assert.deepEqual(node._msImages[1].crop, { x: 0.1, y: 0.2, w: 0.5, h: 0.5 });
        assert.equal(node._msImages[1].rotation, 90);
        assert.equal(input.attached, false, "the picker was removed");
        assert.deepEqual(toasts(), ["success/Image replaced"]);
        assert.equal(node._msHistory.past.length, 1, "relinking is an undoable edit");
    });
});

describe("copy original image", () => {
    const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

    it("offers the entry only over a card and copies the file as PNG", async () => {
        const node = plainNode(nodeType);
        setImages(node, [item("photo.jpg")]);
        const written = [];
        define("fetch", async () => ({ ok: true, status: 200, blob: async () => ({ type: "image/jpeg" }) }));
        define("ClipboardItem", class { constructor(parts) { this.parts = parts; } });
        define("navigator", { clipboard: { async write(items) { written.push(await items[0].parts["image/png"]); } } });

        // Off a card only the node-wide entry is offered, not the per-image ones.
        const off = [];
        nodeType.prototype.getExtraMenuOptions.call(node, { graph_mouse: [card(0).x + 65, card(0).y - 30] }, off);
        assert.deepEqual(off.map((o) => o?.content ?? null), ["Copy stitched result", "Show size panel (width / height outputs)", null]);

        const options = [];
        nodeType.prototype.getExtraMenuOptions.call(node, { graph_mouse: [card(0).x + 65, card(0).y + 46] }, options);
        assert.equal(options[0].content, "Copy original image #1");
        assert.equal(options[1].content, "Replace image #1…");
        await options[0].callback();
        assert.equal(written.length, 1);
        assert.equal(written[0].type, "image/png", "a JPEG source is re-encoded");
        assert.deepEqual(toasts(), ["success/Copied"]);
    });

    it("reports a missing file instead of throwing", async () => {
        const node = plainNode(nodeType);
        setImages(node, [item("gone.png")]);
        define("fetch", async () => ({ ok: false, status: 404, statusText: "Not Found" }));
        const options = [];
        nodeType.prototype.getExtraMenuOptions.call(node, { graph_mouse: [card(0).x + 65, card(0).y + 46] }, options);
        await options[0].callback();
        assert.deepEqual(toasts(), ["error/Copy failed"]);
    });
});

describe("copy the stitched result", () => {
    const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    const armClipboard = () => {
        const written = [];
        define("ClipboardItem", class { constructor(parts) { this.parts = parts; } });
        define("navigator", { clipboard: { async write(items) { written.push(await items[0].parts["image/png"]); } } });
        return written;
    };
    const lastToast = () => app.extensionManager.toast.log.at(-1);

    it("renders the composite from the originals at the final size and copies it as PNG", async () => {
        const node = makeNode(nodeType, { inputs: [{ name: "images", link: 3 }] });
        dom.imageSizes.set("a.png", [40, 20]);
        dom.imageSizes.set("b.png", [20, 20]);
        setImages(node, [item("a.png"), item("b.png", { rotation: 90 })]);
        widget(node, "output_limit").value = "max_width";
        widget(node, "output_limit_px").value = 30;
        paintedCalls(nodeType, node);
        await waitForThumbs(node);
        const written = armClipboard();
        dom.canvases.length = 0;

        assert.equal(click(node, control.copy), true);
        assert.equal(node._msCopying, true);
        await until(() => !node._msCopying);

        // strip/right, native size: 40×20 next to the rotated 20×20 → 60×20, capped to 30 wide.
        const result = dom.canvases.find((c) => c.width === 30 && c.height === 10);
        assert.ok(result, `no 30×10 canvas among ${dom.canvases.map((c) => `${c.width}×${c.height}`).join(", ")}`);
        assert.equal(result.draws, 2, "both originals drawn into the result");
        assert.equal(written.length, 1);
        assert.equal(written[0].type, "image/png");
        assert.equal(`${lastToast().severity}/${lastToast().summary}`, "success/Copied");
        assert.match(lastToast().detail, /30×10/);
        assert.match(lastToast().detail, /IMAGE input frames not included/);
        assert.equal(node.title, "Multi Stitch Images");
    });

    it("leaves an image that failed to load blank and says so", async () => {
        const node = plainNode(nodeType);
        dom.imageSizes.set("a.png", [40, 20]);
        setImages(node, [item("a.png"), item("gone.png")]);
        paintedCalls(nodeType, node);
        await waitForThumbs(node);
        armClipboard();
        dom.canvases.length = 0;
        click(node, control.copy);
        await until(() => !node._msCopying);
        const result = dom.canvases.find((c) => c.width === 80 && c.height === 20);
        assert.ok(result, "the layout keeps the missing image's slot");
        assert.equal(result.draws, 1);
        assert.match(lastToast().detail, /1 not loaded, left blank/);
    });

    it("refuses a result too large for a browser canvas", async () => {
        const node = plainNode(nodeType);
        dom.imageSizes.set("huge.png", [9000, 9000]);
        setImages(node, [item("huge.png")]);
        paintedCalls(nodeType, node);
        await waitForThumbs(node);
        const written = armClipboard();
        click(node, control.copy);
        await until(() => !node._msCopying);
        assert.equal(written.length, 0);
        assert.equal(`${lastToast().severity}/${lastToast().summary}`, "error/Copy failed");
        assert.match(lastToast().detail, /too large.*output_limit/);
    });

    it("is offered in the context menu anywhere on the node", () => {
        const node = plainNode(nodeType);
        setImages(node, [item("a.png")]);
        const options = [];
        nodeType.prototype.getExtraMenuOptions.call(node, { graph_mouse: [200, 40] }, options);
        assert.equal(options[0].content, "Copy stitched result");
        const empty = [];
        nodeType.prototype.getExtraMenuOptions.call(plainNode(nodeType), { graph_mouse: [200, 40] }, empty);
        assert.deepEqual(empty.map((o) => o?.content ?? null), ["Show size panel (width / height outputs)", null], "nothing to copy on an empty node");
    });
});

describe("match reference", () => {
    const change = (node, name, value, old) => {
        widget(node, name).value = value;
        nodeType.prototype.onWidgetChanged.call(node, name, value, old, widget(node, name));
    };

    it("keeps match_reference under Options while matching is on and hides it when matching is off", () => {
        const node = makeNode(nodeType);
        assert.equal(widget(node, "match_image_size").value, true, "matching is on by default");
        assert.equal(widget(node, "match_reference").options.hidden, true, "folded with the other options");
        assert.equal(click(node, control.options), true);
        assert.equal(widget(node, "match_reference").options.hidden, false);
        change(node, "match_image_size", false, true);
        assert.equal(widget(node, "match_reference").options.hidden, true, "irrelevant while matching is off");
        change(node, "match_image_size", true, false);
        click(node, control.options);
        assert.equal(widget(node, "match_reference").options.hidden, true);
        change(node, "match_reference", "largest", "smallest");
        assert.equal(widget(node, "match_reference").options.hidden, false, "a non-default value stays visible");
        assert.ok(paintedText(nodeType, node).includes("Options ▸ (1)"));
    });

    it("matches a strip to the smallest or largest image without reordering", async () => {
        const node = plainNode(nodeType);
        dom.imageSizes.set("a.png", [40, 40]);
        dom.imageSizes.set("b.png", [20, 20]);
        setImages(node, [item("a.png"), item("b.png")]);
        widget(node, "match_image_size").value = true;
        widget(node, "match_reference").value = "smallest";
        paintedCalls(nodeType, node);
        await waitForThumbs(node);
        // a shrinks to b's height: 20×20 + 20×20.
        assert.match(paintedText(nodeType, node)[0], /~40×20/);
        widget(node, "match_reference").value = "largest";
        // b grows to a's height: 40×40 + 40×40.
        assert.match(paintedText(nodeType, node)[0], /~80×40/);
        widget(node, "match_reference").value = "first";
        assert.match(paintedText(nodeType, node)[0], /~80×40/);
    });

    it("restores defaults for widget values an older workflow left empty or invalid", () => {
        const node = makeNode(nodeType);
        // A 1.1 workflow: no slot for match_reference, and the removed button
        // widgets left nulls; a combo can also hold a value that no longer exists.
        widget(node, "match_reference").value = null;
        widget(node, "output_limit").value = undefined;
        widget(node, "layout_mode").options.values = ["strip", "grid"];
        widget(node, "layout_mode").value = "mosaic";
        widget(node, "size_reference").type = "number";
        widget(node, "size_reference").value = "largest";
        widget(node, "spacing_width").value = 8;
        nodeType.prototype.onConfigure.call(node, { properties: { multi_stitch_images: "[]" } });
        assert.equal(widget(node, "match_reference").value, "first", "the behaviour the workflow was saved with, not today's default");
        assert.equal(widget(node, "output_limit").value, "none");
        assert.equal(widget(node, "layout_mode").value, "strip");
        assert.equal(widget(node, "size_reference").value, 1, "a name on a number widget goes back to the default");
        assert.equal(widget(node, "spacing_width").value, 8, "a valid value is kept");
    });
});

describe("video frames", () => {
    const SERVER_PREVIEW_WAIT = 160;
    const frame = (w = 640, h = 360) => {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        return canvas;
    };
    const deleteCalls = () => api.calls.filter((c) => c.path === "/multi_stitch/video/delete")
        .map((c) => JSON.parse(c.options.body).filenames);

    it("uploads a video to the temp folder as a session-only entry and opens the picker", async () => {
        const node = plainNode(nodeType);
        await node.pasteFiles([videoFile("clip.mp4")]);
        assert.equal(api.uploads.length, 1);
        assert.deepEqual(api.uploadTargets[0], { type: "temp", subfolder: "multi_stitch_video" });
        assert.equal(node._msVideos.length, 1);
        const entry = node._msVideos[0];
        assert.equal(entry.kind, "video");
        assert.equal(entry.name, "clip.mp4");
        assert.equal(node._msImages.length, 0, "a video is not an image");
        assert.equal(widget(node, "images_json").value, "[]");
        assert.ok(node._msPicker, "one video opens the frame picker right away");
        assert.equal(node._msPicker.entry, entry);
        assert.equal(node._msPicker.video.src, shared.imageUrl(entry));
        assert.match(node._msPicker.video.src, /type=temp/);

        // The card follows the images, says what it is, and is not saved.
        assert.ok(paintedText(nodeType, node).some((t) => /1 video — click the card to capture frames/.test(t)));
        const data = { properties: {} };
        nodeType.prototype.onSerialize.call(node, data);
        assert.equal(data.properties.multi_stitch_images, "[]");
        node._msPicker.close(false);
        assert.equal(node._msPicker, null);
        assert.equal(node._msVideos.length, 1, "Keep & close leaves the video for later");
    });

    it("also accepts a video by extension when the browser gives it no MIME type", async () => {
        const node = plainNode(nodeType);
        await node.pasteFiles([videoFile("clip.MOV", ""), { name: "notes.txt", type: "" }]);
        assert.equal(node._msVideos.length, 1);
        assert.equal(api.uploads.length, 1);
        node._msPicker?.close(false);
    });

    it("turns a captured frame into an ordinary, editable image tagged with its time", async () => {
        const node = plainNode(nodeType);
        await node.pasteFiles([videoFile("scene take 2.mov")]);
        const entry = node._msVideos[0];
        node._msPicker.close(false);
        const item = await node.captureVideoFrame(entry, frame(), 12.3456);
        assert.equal(node._msImages.length, 1);
        assert.equal(node._msImages[0], item);
        assert.match(item.filename, /^multi_stitch_.*\.png$/, "uploaded under the node's naming scheme");
        assert.deepEqual(api.uploadTargets.at(-1), { type: "input", subfolder: "multi_stitch" }, "captures are ordinary images");
        assert.deepEqual(item.source, { video: "scene take 2.mov", time: 12.346 });
        assert.deepEqual(item.crop, { x: 0, y: 0, w: 1, h: 1 });
        assert.equal(JSON.parse(widget(node, "images_json").value)[0].source.time, 12.346, "the source survives a save");
        assert.equal(node._msHistory.past.length, 1, "a capture is an undoable edit");
        assert.equal(node._msVideos.length, 1, "capturing keeps the video until Done");
    });

    it("deletes the temp file when the video card's × is clicked, keeping the captures", async () => {
        const node = plainNode(nodeType);
        await node.pasteFiles([videoFile()]);
        const entry = node._msVideos[0];
        node._msPicker.close(false);
        await node.captureVideoFrame(entry, frame(), 1);
        api.calls.length = 0;
        // The video card follows the one image: card 1, × top-right.
        const r = card(1);
        assert.equal(click(node, [r.x + r.w - 13, r.y + 12]), true);
        assert.equal(node._msVideos.length, 0);
        assert.equal(node._msImages.length, 1, "the captured frame stays");
        await tick(2);
        assert.deepEqual(deleteCalls(), [[entry.filename]]);
        assert.match(toasts().at(-1), /Video removed/);
    });

    it("Done in the picker removes the video; Clear and node removal delete the rest", async () => {
        const node = plainNode(nodeType);
        await node.pasteFiles([videoFile("a.mp4")]);
        const a = node._msVideos[0];
        api.calls.length = 0;
        node._msPicker.close(true);
        await tick(2);
        assert.equal(node._msVideos.length, 0);
        assert.deepEqual(deleteCalls(), [[a.filename]]);

        await node.pasteFiles([videoFile("b.mp4"), videoFile("c.mp4")]);
        assert.equal(node._msPicker, null, "two videos: no automatic picker");
        const [b, c] = node._msVideos;
        api.calls.length = 0;
        click(node, control.clear);
        await tick(2);
        assert.equal(node._msVideos.length, 0);
        assert.deepEqual(deleteCalls(), [[b.filename, c.filename]], "one request for all of them");

        await node.pasteFiles([videoFile("d.mp4")]);
        const d = node._msVideos[0];
        api.calls.length = 0;
        nodeType.prototype.onRemoved.call(node);
        await tick(2);
        assert.deepEqual(deleteCalls(), [[d.filename]]);
    });

    it("falls back to server decoding when the browser cannot play the video", async () => {
        const node = plainNode(nodeType);
        const entry = { kind: "video", filename: "odd.mkv", name: "odd.mkv", subfolder: "multi_stitch_video", type: "temp" };
        const served = [];
        const handle = picker.openFramePicker(node, entry, { onServerFrame: (data, time) => { served.push({ data, time }); return data; } });
        assert.equal(handle.state.server.active, false);
        api.calls.length = 0;
        // The <video> reports an error, as it does for a codec it cannot decode.
        handle.video.handlers.error[0]();
        await tick(5);
        assert.equal(handle.state.server.active, true);
        assert.ok(api.calls.some((c) => c.path.startsWith("/multi_stitch/video/info?filename=odd.mkv")));
        assert.deepEqual([entry.width, entry.height, entry.duration], [320, 180, 2]);
        assert.equal(handle.video.style.display, "none");

        // Steps follow the server's frame rate and previews come from the server.
        handle.step(1);
        assert.ok(Math.abs(handle.currentTime() - 0.15) < 1e-9, `one 10 fps frame in: ${handle.currentTime()}`);
        handle.seekTo(1.5);
        assert.equal(handle.currentTime(), 1.5);
        await tick(SERVER_PREVIEW_WAIT);
        assert.match(handle.serverFrame.src, /\/multi_stitch\/video\/frame\?filename=odd\.mkv&time=1\.500&max_side=720/);

        // A capture asks the server for the exact frame and hands the file to the node.
        const result = await handle.capture();
        assert.equal(served.length, 1);
        assert.equal(served[0].time, 1.5);
        assert.equal(served[0].data.name, api.uploads.at(-1));
        assert.deepEqual([served[0].data.width, served[0].data.height], [320, 180]);
        assert.equal(result, served[0].data);
        const post = api.calls.find((c) => c.path === "/multi_stitch/video/capture");
        assert.deepEqual(JSON.parse(post.options.body), { filename: "odd.mkv", time: 1.5 });
        assert.equal(handle.state.captures, 1);
        handle.close(false);
    });

    it("says so when neither the browser nor the server can decode the video", async () => {
        const node = plainNode(nodeType);
        const entry = { kind: "video", filename: "odd.mkv", name: "odd.mkv" };
        const handle = picker.openFramePicker(node, entry, {});
        api.knobs.serverVideo = false;
        try {
            handle.video.handlers.error[0]();
            await tick(5);
            assert.equal(handle.state.server.active, false);
            assert.equal(handle.state.server.available, false);
            assert.match(handle.overlay.querySelector(".ms-video-status").textContent, /server cannot decode it either.*PyAV/);
            assert.equal(await handle.setServerCapture(true), false, "the checkbox cannot be turned on either");
        } finally {
            api.knobs.serverVideo = true;
            handle.close(false);
        }
    });

    it("can capture on the server while the browser shows the video", async () => {
        const node = plainNode(nodeType);
        const entry = { kind: "video", filename: "clip.mp4", name: "clip.mp4" };
        const captured = [];
        const served = [];
        const handle = picker.openFramePicker(node, entry, {
            onCapture: (canvas, time) => { captured.push(time); return { canvas }; },
            onServerFrame: (data, time) => { served.push(time); return data; },
        });
        assert.equal(await handle.setServerCapture(true), true);
        assert.equal(handle.state.server.active, false, "the browser keeps playing");
        handle.state.mediaTime = 0.7;
        handle.state.hasFrameCallback = true;
        await handle.capture();
        assert.deepEqual([captured, served], [[], [0.7]]);
        assert.equal(await handle.setServerCapture(false), false);
        handle.video.readyState = 2;
        handle.video.videoWidth = 320;
        handle.video.videoHeight = 180;
        await handle.capture();
        assert.deepEqual([captured, served], [[0.7], [0.7]]);
        handle.close(false);
    });

    it("gets the poster from the server for a video the browser cannot play, then captures there", async () => {
        const node = plainNode(nodeType);
        await node.pasteFiles([videoFile("odd.mkv", "video/x-matroska")]);
        const entry = node._msVideos[0];
        node._msPicker.close(false);
        dom.imageSizes.set(entry.filename, [640, 360]);
        // The poster <video> (the one with handlers; the picker's own has none)
        // fails as the browser's decoder would; the server renders one instead.
        dom.videos.filter((v) => typeof v.onerror === "function").at(-1).onerror();
        await tick(5);
        assert.equal(entry.serverOnly, true);
        assert.ok(entry.poster, "a poster drawn from the server's frame");
        assert.deepEqual([entry.width, entry.height], [640, 360]);

        // Opening the card goes straight to server mode; a capture lands as an ordinary image.
        const r = card(0);
        assert.equal(click(node, [r.x + 60, r.y + 40]), true);
        await tick(5);
        assert.equal(node._msPicker.state.server.active, true);
        node._msPicker.seekTo(1.2);
        const item = await node._msPicker.capture();
        assert.equal(node._msImages.length, 1);
        assert.equal(node._msImages[0], item);
        assert.match(item.filename, /^multi_stitch_server_\d+\.png$/);
        assert.deepEqual(item.source, { video: "odd.mkv", time: 1.2, server: true });
        assert.deepEqual(item.crop, { x: 0, y: 0, w: 1, h: 1 });
        node._msPicker.close(false);
    });

    it("names captures after the video and formats times the way the cards show them", () => {
        assert.equal(picker.captureFileName({ name: "My Clip (final).mp4" }, 3.5), "My_Clip_final__3s500.png");
        assert.equal(picker.captureFileName({ filename: "x.webm" }, -1), "x_0s000.png");
        assert.equal(picker.formatTime(75.25), "01:15.250");
        assert.equal(picker.formatTime(NaN), "00:00.000");
    });
});

describe("size panel", () => {
    const SIZE_NAMES = ["size_reference", "size_megapixels", "size_divisible_by"];
    // Centre of the title-bar pill: x = 420 − 34 − 64 + 32, y in the 30px title above the body.
    const TITLE_BUTTON = [354, -15];

    it("is off by default, toggles from the title bar and shows the outputs' size", async () => {
        const node = plainNode(nodeType);
        dom.imageSizes.set("tall.png", [1440, 2560]);
        setImages(node, [item("tall.png")]);
        widget(node, "size_megapixels").value = 0.8;
        paintedCalls(nodeType, node);
        await waitForThumbs(node);
        for (const name of SIZE_NAMES) assert.equal(widget(node, name).options.hidden, true, `${name} hidden while off`);
        const before = node.size[1];
        assert.ok(paintedText(nodeType, node).includes("📐 Size"), "the title-bar pill is drawn");

        assert.equal(click(node, TITLE_BUTTON), true);
        assert.equal(node.properties.multi_stitch_size_panel, true);
        assert.equal(node.size[1], before + 176 + 8, "the node grows by the panel");
        for (const name of SIZE_NAMES) assert.equal(widget(node, name).options.hidden, false, `${name} shown while on`);
        const painted = paintedText(nodeType, node);
        assert.ok(painted.includes("672 x 1184  |  9:16  |  0.80 MP  |  divisible by 32"), painted.join(" | "));
        assert.ok(painted.includes("from image 1 (1440×2560)"));
        assert.ok(painted.includes("📐 Size ✓"));

        click(node, TITLE_BUTTON);
        assert.equal(node.properties.multi_stitch_size_panel, false);
        assert.equal(node.size[1], before);
    });

    it("follows the reference choice and the step, and is offered in the context menu", async () => {
        const node = plainNode(nodeType);
        dom.imageSizes.set("a.png", [100, 100]);
        dom.imageSizes.set("b.png", [300, 150]);
        setImages(node, [item("a.png"), item("b.png")]);
        node.properties.multi_stitch_size_panel = true;
        widget(node, "size_reference").value = 2;
        widget(node, "size_divisible_by").value = 64;
        paintedCalls(nodeType, node);
        await waitForThumbs(node);
        // Image 2 is 300×150: 300/64 = 4.69 → 5, 150/64 = 2.34 → 2.
        assert.ok(paintedText(nodeType, node).includes("320 x 128  |  2:1  |  0.04 MP  |  divisible by 64"));
        assert.ok(paintedText(nodeType, node).includes("from image 2 (300×150)"));
        // A number past the end means the last image, and the panel says so.
        widget(node, "size_reference").value = 9;
        assert.ok(paintedText(nodeType, node).includes("from image 2 (300×150) — size_reference 9 is past the end"));
        widget(node, "size_reference").value = 1;
        assert.ok(paintedText(nodeType, node).includes("128 x 128  |  1:1  |  0.02 MP  |  divisible by 64"));

        const options = [];
        nodeType.prototype.getExtraMenuOptions.call(node, { graph_mouse: [200, 40] }, options);
        const entry = options.find((o) => /size panel/i.test(o?.content || ""));
        assert.equal(entry.content, "Hide size panel");
        entry.callback();
        assert.equal(node.properties.multi_stitch_size_panel, false);
        for (const name of SIZE_NAMES) assert.equal(widget(node, name).options.hidden, true);
    });

    it("explains itself on an empty node instead of hiding", () => {
        const node = plainNode(nodeType);
        node.properties.multi_stitch_size_panel = true;
        const painted = paintedText(nodeType, node);
        assert.ok(painted.some((t) => /Add an image: its size becomes the width \/ height outputs/.test(t)));
        assert.equal(node.size[1], 148 + 92 + 12 + 176 + 8);
    });
});

describe("native-reference refinements", () => {
    it("matches new nodes to the smallest image and keeps an explicit saved choice", () => {
        const node = makeNode(nodeType);
        assert.equal(widget(node, "match_image_size").value, true);
        assert.equal(widget(node, "match_reference").value, "smallest");
        widget(node, "match_image_size").value = false;
        nodeType.prototype.onConfigure.call(node, { properties: { multi_stitch_images: "[]" } });
        assert.equal(widget(node, "match_image_size").value, false);
    });
    it("rounds crop edges and quarter-turns exactly like Python", () => {
        assert.deepEqual(shared.cropPixelBox(10, 10, { x: .15, y: .15, w: .3, h: .3 }), { x: 2, y: 2, w: 2, h: 2 });
        assert.equal(shared.normalizeTransform({ rotation: 45 }).rotation, 0);
        assert.equal(shared.normalizeTransform({ rotation: Infinity }).rotation, 0);
        assert.deepEqual(shared.normalizeCrop({ x: null, w: null }), shared.defaultCrop());
    });
    it("limits simultaneous thumbnail loads and releases a removed node", async () => {
        const OriginalImage = globalThis.Image;
        const pending = [];
        let active = 0, peak = 0;
        globalThis.Image = class {
            set src(value) {
                if (!value) return;
                active++; peak = Math.max(active, peak);
                pending.push(() => { active--; this.naturalWidth = 4000; this.naturalHeight = 3000; this.onload?.(); });
            }
        };
        try {
            const node = makeNode(nodeType);
            for (let i = 0; i < 8; i++) shared.loadThumb(node, item(`queued${i}.png`));
            assert.equal(active, 2);
            while (pending.length) pending.shift()();
            assert.equal(peak, 2);
            assert.ok([...node._msThumbCache.values()].every(state => state.ready && state.image.width <= 512));
            shared.loadThumb(node, item("cancelled.png"));
            nodeType.prototype.onRemoved.call(node);
            assert.equal(node._msThumbCache.size, 0);
            while (pending.length) pending.shift()();
        } finally { globalThis.Image = OriginalImage; }
    });
});
