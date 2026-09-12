// The DOM rendering used in ComfyUI's Vue node mode: it must show the same
// state as the canvas, drive the same actions, ask for the height it needs and
// stay out of the saved workflow.
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installDom, item, loadExtension, stageExtension } from "./harness.mjs";

let view, dom;

before(async () => {
    dom = installDom();
    const root = stageExtension();
    await loadExtension(root);
    view = await import(pathToFileURL(join(root, "pkg", "web", "dom_view.js")).href);
});

// A node with just enough LiteGraph shape for a DOM widget.
function fakeNode(images = []) {
    const node = {
        id: 3,
        size: [420, 300],
        widgets: [],
        properties: {},
        graph: { setDirtyCanvas() {} },
        _msImages: images,
        _msVideos: [],
        addDOMWidget(name, type, element, options) {
            const widget = { name, type, element, options, serialize: undefined };
            node.widgets.push(widget);
            return widget;
        },
        removeWidget(widget) {
            node.widgets.splice(node.widgets.indexOf(widget), 1);
        },
        setSize(size) { node.size = [...size]; },
    };
    return node;
}

// Records every action the buttons call, and reports the state they read.
function actionSpy(overrides = {}) {
    const calls = [];
    const state = { preview: true, options: false, panel: false, undo: true, redo: false };
    const record = (name) => (node, ...rest) => { calls.push([name, ...rest.filter((v) => typeof v !== "object")]); };
    return {
        calls, state,
        actions: {
            items: (node) => node._msImages,
            videos: (node) => node._msVideos,
            status: () => "2 images  •  ~800×300",
            canUndo: () => state.undo,
            canRedo: () => state.redo,
            previewOn: () => state.preview,
            optionsOn: () => state.options,
            optionsCount: () => 2,
            sizePanelOn: () => state.panel,
            thumb: (node, entry) => ({ ready: !entry.pending && !entry.failed, failed: !!entry.failed, message: entry.message, image: { width: 4, height: 4 } }),
            drawThumb: () => calls.push(["drawThumb"]),
            drawPreview: () => calls.push(["drawPreview"]),
            drawSizePanel: () => calls.push(["drawSizePanel"]),
            add: record("add"),
            addFiles: (node, files) => calls.push(["addFiles", files.length]),
            clear: record("clear"),
            copy: record("copy"),
            undo: record("undo"),
            redo: record("redo"),
            togglePreview: (node) => { state.preview = !state.preview; calls.push(["togglePreview"]); },
            toggleOptions: (node) => { state.options = !state.options; calls.push(["toggleOptions"]); },
            toggleSizePanel: (node) => { state.panel = !state.panel; calls.push(["toggleSizePanel"]); },
            openGallery: record("openGallery"),
            edit: (node, index) => calls.push(["edit", index]),
            remove: (node, index) => calls.push(["remove", index]),
            move: (node, index, delta) => calls.push(["move", index, delta]),
            openVideo: (node, entry) => calls.push(["openVideo", entry.filename]),
            removeVideo: (node, entry) => calls.push(["removeVideo", entry.filename]),
            resized: record("resized"),
            ...overrides,
        },
    };
}

const part = (root, className) => root.children.find((child) => child.className === className);
const buttons = (root) => part(root, "toolbar").children;
const press = (root, label) => buttons(root).find((b) => b.textContent.startsWith(label))?.handlers?.click?.[0]?.({ stopPropagation() {} });
const cards = (root) => part(root, "cards").children;
const cardButton = (card, className) => card.children.find((child) => child.className === className);

beforeEach(() => {
    dom.overlays.length = 0;
});

describe("dom view", () => {
    it("does nothing on a node that cannot hold a DOM widget", () => {
        const node = fakeNode();
        delete node.addDOMWidget;
        assert.equal(view.installDomView(node, actionSpy().actions), null);
        assert.equal(view.domView(node), null);
    });

    it("renders the status, the toolbar and one card per image", () => {
        const node = fakeNode([item("a.png"), item("b.png", { crop: { x: 0.1, y: 0, w: 0.8, h: 1 } })]);
        const spy = actionSpy();
        const handle = view.installDomView(node, spy.actions);
        assert.equal(view.domView(node), handle);
        assert.equal(part(handle.root, "status").textContent, "2 images  •  ~800×300");
        assert.deepEqual(buttons(handle.root).map((b) => b.textContent),
            ["+ Add", "Clear", "⧉ Copy", "↶", "↷", "Preview ✓", "Options ▸ (2)", "🖼 Gallery", "📐 Size"]);
        assert.equal(cards(handle.root).length, 2);
        assert.equal(cards(handle.root)[1].className, "card edited", "a cropped image is marked, as on the canvas");
        assert.equal(part(handle.root, "empty").hidden, true, "no dashed box while there are images");
        assert.equal(part(handle.root, "preview").hidden, false);
        assert.equal(part(handle.root, "panel").hidden, true);
        handle.destroy();
    });

    it("explains itself and offers the box when the list is empty", () => {
        const node = fakeNode();
        const handle = view.installDomView(node, actionSpy().actions);
        assert.equal(part(handle.root, "empty").hidden, false);
        assert.match(part(handle.root, "empty").textContent, /Drop or add images or a video/);
        assert.equal(part(handle.root, "cards").hidden, true);
        assert.equal(part(handle.root, "preview").hidden, true, "nothing to preview");
        handle.destroy();
    });

    it("routes every button and card control to the actions the canvas uses", () => {
        const node = fakeNode([item("a.png"), item("b.png")]);
        const spy = actionSpy();
        const handle = view.installDomView(node, spy.actions);
        for (const label of ["+ Add", "Clear", "⧉ Copy", "↶", "↷", "🖼 Gallery"]) press(handle.root, label);
        press(handle.root, "Preview");
        press(handle.root, "Options");
        press(handle.root, "📐");
        const card = cards(handle.root)[1];
        cardButton(card, "btn remove").handlers.click[0]({ stopPropagation() {} });
        cardButton(card, "btn prev").handlers.click[0]({ stopPropagation() {} });
        cardButton(card, "btn next").handlers.click[0]({ stopPropagation() {} });
        card.children.find((c) => c.className === "thumb").handlers.click[0]();
        assert.deepEqual(spy.calls.filter(([name]) => name !== "drawThumb" && name !== "drawPreview" && name !== "resized"), [
            ["add"], ["clear"], ["copy"], ["undo"], ["redo"], ["openGallery"],
            ["togglePreview"], ["toggleOptions"], ["toggleSizePanel"],
            ["remove", 1], ["move", 1, -1], ["move", 1, 1], ["edit", 1],
        ]);
        handle.destroy();
    });

    it("follows the state its actions report", () => {
        const node = fakeNode([item("a.png")]);
        const spy = actionSpy();
        spy.state.preview = false;
        spy.state.options = true;
        spy.state.panel = true;
        spy.state.undo = false;
        const handle = view.installDomView(node, spy.actions);
        const labels = buttons(handle.root).map((b) => b.textContent);
        assert.ok(labels.includes("Preview"), "off, so no tick");
        assert.ok(labels.includes("Options ▾"), "open, so no count");
        assert.ok(labels.includes("📐 Size ✓"));
        assert.equal(buttons(handle.root).find((b) => b.textContent === "↶").disabled, true, "nothing to undo");
        assert.equal(part(handle.root, "preview").hidden, true);
        assert.equal(part(handle.root, "panel").hidden, false);
        handle.destroy();
    });

    it("shows a video card that opens the picker, and a card's failure message", () => {
        const node = fakeNode([item("bad.png", { failed: true, message: "Timed out · click to retry" })]);
        node._msImages[0].failed = true;
        node._msVideos = [{ filename: "clip.mp4", name: "clip.mp4", duration: 2, poster: null }];
        const spy = actionSpy();
        const handle = view.installDomView(node, spy.actions);
        const [image, video] = cards(handle.root);
        assert.equal(image.children.find((c) => c.className === "text failed").textContent, "Timed out · click to retry");
        assert.match(video.children.find((c) => c.className === "label").textContent, /clip\.mp4/);
        video.children.find((c) => c.className === "text").handlers.click[0]();
        video.children.find((c) => c.className === "btn remove").handlers.click[0]({ stopPropagation() {} });
        assert.deepEqual(spy.calls.filter(([name]) => name.startsWith("open") || name.startsWith("remove")),
            [["openVideo", "clip.mp4"], ["removeVideo", "clip.mp4"]]);
        handle.destroy();
    });

    it("asks for a height that follows the rows, and never joins the saved workflow", () => {
        const node = fakeNode([item("a.png")]);
        const spy = actionSpy();
        spy.state.preview = false;
        const handle = view.installDomView(node, spy.actions);
        const widget = node.widgets[0];
        assert.equal(widget.name, "$$multi_stitch_view", "a pseudo-widget name the frontend skips");
        assert.equal(widget.serialize, false, "the flag the frontend reads");
        assert.equal(widget.options.serialize, false);
        assert.equal(widget.serializeValue(), undefined);
        const height = () => widget.options.getHeight();
        const oneRow = height();
        node._msImages = [item("a.png"), item("b.png"), item("c.png"), item("d.png")];
        handle.render();
        assert.ok(height() > oneRow, "a second row makes it taller");
        assert.deepEqual(widget.computeLayoutSize(), { minHeight: height(), maxHeight: height(), minWidth: 420 });
        handle.destroy();
    });

    it("takes a drop of files and hands them to the node", () => {
        const node = fakeNode();
        const spy = actionSpy();
        const handle = view.installDomView(node, spy.actions);
        const stop = { preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [{ name: "a.png" }, { name: "b.mp4" }], items: [{ kind: "file" }] } };
        handle.root.handlers.dragover[0](stop);
        handle.root.handlers.drop[0](stop);
        assert.deepEqual(spy.calls.filter(([name]) => name === "addFiles"), [["addFiles", 2]]);
        handle.destroy();
    });

    it("removes its widget and stops refreshing when the node goes", () => {
        const node = fakeNode([item("a.png", { pending: true })]);
        const spy = actionSpy();
        const handle = view.installDomView(node, spy.actions);
        assert.equal(node.widgets.length, 1);
        handle.destroy();
        assert.equal(node.widgets.length, 0);
        assert.equal(view.domView(node), null);
        assert.equal(handle.root.attached, false);
        // A refresh after removal must not schedule anything.
        view.refreshDomView(node);
        assert.equal(handle.alive, false);
    });

    it("reads the Vue node setting defensively", () => {
        assert.equal(view.vueNodesEnabled(undefined), false);
        assert.equal(view.vueNodesEnabled({ extensionManager: { setting: { get: () => true } } }), true);
        assert.equal(view.vueNodesEnabled({ extensionManager: { setting: { get: () => "yes" } } }), false, "only a real true counts");
        assert.equal(view.vueNodesEnabled({ extensionManager: { setting: { get() { throw new Error("no such setting"); } } } }), false);
    });
});
