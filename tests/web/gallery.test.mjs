// The gallery modal against the stub DOM: listing, the per-entry actions and
// the routes they call, with a gallery-aware stand-in for fetchApi.
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installDom, loadExtension, stageExtension } from "./harness.mjs";

let api, gallery, dom;
// What the fake server holds; each test resets it.
const server = { entries: [], storage: null, posts: [] };

const entry = (id, extra = {}) => ({
    id, name: `Set ${id}`, created: 1789200000, used: 1789200000 + Number(id), uses: 1, preview: true,
    images: [{ filename: `${id}_a.png`, subfolder: "multi_stitch", type: "input" }, { filename: `${id}_b.png`, subfolder: "multi_stitch", type: "input" }],
    settings: { direction: "right", layout_mode: "strip" }, width: 800, height: 300, ...extra,
});

before(async () => {
    dom = installDom();
    const root = stageExtension();
    ({ api } = (await loadExtension(root)).api);
    gallery = await import(pathToFileURL(join(root, "pkg", "web", "gallery.js")).href);
    const original = api.fetchApi;
    api.fetchApi = async (path, options = {}) => {
        if (!path.startsWith("/multi_stitch/gallery")) return original(path, options);
        const body = options.body ? JSON.parse(options.body) : null;
        if (options.method === "POST") server.posts.push({ path, body });
        const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
        if (path === "/multi_stitch/gallery") return ok({ entries: server.entries, storage: server.storage });
        if (path === "/multi_stitch/gallery/save") {
            const saved = entry("saved", { name: body.name || "2026-09-12 10:00", images: body.images, settings: body.settings });
            server.entries = [saved, ...server.entries];
            return ok({ entry: saved, storage: server.storage });
        }
        if (path === "/multi_stitch/gallery/rename") {
            const target = server.entries.find((e) => e.id === body.id);
            if (!target) return { ok: false, status: 404, json: async () => ({ error: "gallery entry not found" }) };
            target.name = body.name;
            return ok({ entry: target });
        }
        if (path === "/multi_stitch/gallery/delete") {
            server.entries = server.entries.filter((e) => !body.ids.includes(e.id));
            return ok({ removed: body.ids, missing: [], files_removed: body.files ? 2 : 0, bytes_freed: body.files ? 2048 : 0, storage: server.storage });
        }
        if (path === "/multi_stitch/gallery/cleanup") return ok({ files_removed: 3, bytes_freed: 3 * 1024 * 1024, storage: { ...server.storage, unreferenced_files: 0, unreferenced_bytes: 0 } });
        return { ok: false, status: 404, json: async () => ({ error: `no route ${path}` }) };
    };
});

beforeEach(() => {
    server.entries = [entry("2"), entry("1")];
    server.storage = { files: 31, bytes: 12 * 1024 * 1024, unreferenced_files: 5, unreferenced_bytes: 3 * 1024 * 1024, entries: 2 };
    server.posts.length = 0;
    dom.overlays.length = 0;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const part = (element, selector) => element.parts?.[selector];
const fire = (element, type) => element?.handlers?.[type]?.[0]?.();
const cards = (handles) => part(handles.overlay, ".ms-gallery-grid").children.filter((c) => c.className === "ms-gallery-card");
const open = async (hooks = {}) => {
    const handles = gallery.openGallery({ id: 7 }, hooks);
    await settle();
    return handles;
};

describe("gallery formatting", () => {
    it("formats sizes, times, entry lines and the storage summary", () => {
        assert.equal(gallery.formatBytes(512), "512 B");
        assert.equal(gallery.formatBytes(3 * 1024), "3 KB");
        assert.equal(gallery.formatBytes(12.4 * 1024 * 1024), "12.4 MB");
        assert.equal(gallery.formatBytes(2.5 * 1024 ** 3), "2.50 GB");
        assert.equal(gallery.formatWhen(0), "");
        assert.match(gallery.formatWhen(1789200000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
        assert.match(gallery.entryMeta(entry("9", { uses: 3, input_frames: 1 })), /^2 images \+ 1 from IMAGE · 800×300 · used 3× · \d{4}/);
        assert.equal(gallery.entryMeta({ images: [{}] }), "1 image");
        assert.equal(gallery.storageText({ files: 31, bytes: 12 * 1024 * 1024, unreferenced_files: 5, unreferenced_bytes: 3 * 1024 * 1024 }),
            "31 files · 12.0 MB in input/multi_stitch · 5 not in any entry (3.0 MB)");
        assert.equal(gallery.storageText({ files: 1, bytes: 10, unreferenced_files: 0, unreferenced_bytes: 0 }), "1 file · 10 B in input/multi_stitch");
        const url = gallery.previewUrl(entry("3"));
        assert.match(url, /\/view\?filename=3\.jpg&subfolder=multi_stitch%2Fgallery&type=input&t=\d+$/);
        assert.equal(gallery.previewUrl({ id: "x", preview: false }), null);
    });
});

describe("gallery modal", () => {
    it("lists the entries most recent first with their previews and the storage line", async () => {
        const handles = await open();
        assert.equal(dom.overlays.at(-1), handles.overlay, "the overlay is on the page");
        const list = cards(handles);
        assert.equal(list.length, 2);
        assert.match(list[0].innerHTML, /Set 2/);
        assert.match(list[0].innerHTML, /filename=2\.jpg/);
        assert.match(list[0].innerHTML, /2 images · 800×300/);
        assert.match(part(handles.overlay, ".ms-gallery-head .storage").textContent, /^31 files · 12\.0 MB/);
        assert.equal(part(handles.overlay, ".ms-gallery-status").textContent, "");
        handles.close();
        assert.equal(handles.overlay.attached, false);
    });

    it("shows an explanation when the gallery is empty", async () => {
        server.entries = [];
        const handles = await open();
        const grid = part(handles.overlay, ".ms-gallery-grid");
        assert.equal(grid.children.length, 1);
        assert.match(grid.children[0].textContent, /recorded on its first run/);
        handles.close();
    });

    it("loads an entry into the node and closes, or appends without closing", async () => {
        const loaded = [];
        const appended = [];
        let handles = await open({ load: (e) => loaded.push(e.id), append: (e) => appended.push(e.id) });
        fire(part(cards(handles)[1], ".append"), "click");
        await settle();
        assert.deepEqual(appended, ["1"]);
        assert.equal(handles.overlay.attached, true, "Add keeps the gallery open");
        assert.match(part(handles.overlay, ".ms-gallery-status").textContent, /Added the images of "Set 1"/);
        fire(part(cards(handles)[0], ".load"), "click");
        await settle();
        assert.deepEqual(loaded, ["2"]);
        assert.equal(handles.overlay.attached, false, "Load closes the gallery");
        handles = await open({ load: () => { throw new Error("no such file"); } });
        fire(part(cards(handles)[0], ".load"), "click");
        await settle();
        assert.equal(part(handles.overlay, ".ms-gallery-status").textContent, "no such file");
        assert.equal(part(handles.overlay, ".ms-gallery-status").className, "ms-gallery-status error");
        handles.close();
    });

    it("deletes an entry with or without its files, sending the files the workflow still uses", async () => {
        const handles = await open({ keep: () => ["keep_me.png"] });
        fire(part(cards(handles)[0], ".delete"), "click");
        await settle();
        assert.deepEqual(server.posts.at(-1), { path: "/multi_stitch/gallery/delete", body: { ids: ["2"], files: false, keep: ["keep_me.png"] } });
        assert.equal(cards(handles).length, 1, "the list was refreshed");
        fire(part(cards(handles)[0], ".delete-files"), "click");
        await settle();
        assert.deepEqual(server.posts.at(-1).body, { ids: ["1"], files: true, keep: ["keep_me.png"] });
        assert.match(part(handles.overlay, ".ms-gallery-status").textContent, /2 files deleted \(2 KB\)/);
        assert.equal(cards(handles).length, 0);
        handles.close();
    });

    it("declines to delete when the confirmation is refused", async () => {
        const original = globalThis.confirm;
        globalThis.confirm = () => false;
        try {
            const handles = await open();
            fire(part(cards(handles)[0], ".delete"), "click");
            await settle();
            assert.equal(server.posts.length, 0);
            assert.equal(cards(handles).length, 2);
            handles.close();
        } finally {
            globalThis.confirm = original;
        }
    });

    it("saves the current composition by hand and toggles the autosave", async () => {
        let autosave = true;
        const current = { images: [{ filename: "x.png", subfolder: "multi_stitch", type: "input" }], settings: { direction: "down" }, size: [10, 20] };
        const handles = await open({ current: () => current, autosave: { get: () => autosave, set: (v) => { autosave = v; } } });
        assert.equal(part(handles.overlay, ".autosave").checked, true);
        fire(part(handles.overlay, ".save"), "click");
        await settle();
        assert.deepEqual(server.posts.at(-1), { path: "/multi_stitch/gallery/save", body: { ...current } });
        assert.equal(cards(handles).length, 3, "the saved entry appears");
        assert.match(part(handles.overlay, ".ms-gallery-status").textContent, /^Saved /);
        const box = part(handles.overlay, ".autosave");
        box.checked = false;
        fire(box, "change");
        assert.equal(autosave, false);
        handles.close();

        const empty = await open({ current: () => ({ images: [] }) });
        fire(part(empty.overlay, ".save"), "click");
        await settle();
        assert.equal(part(empty.overlay, ".ms-gallery-status").textContent, "Add images to the node first.");
        empty.close();
    });

    it("cleans up unreferenced files after a confirmation, sending the files to keep", async () => {
        const handles = await open({ keep: () => ["a.png", "b.png"] });
        fire(part(handles.overlay, ".cleanup"), "click");
        await settle();
        assert.deepEqual(server.posts.at(-1), { path: "/multi_stitch/gallery/cleanup", body: { keep: ["a.png", "b.png"] } });
        assert.match(part(handles.overlay, ".ms-gallery-status").textContent, /3 files deleted \(3\.0 MB\)/);
        assert.match(part(handles.overlay, ".ms-gallery-head .storage").textContent, /31 files · 12\.0 MB in input\/multi_stitch$/, "no unreferenced files left");
        handles.close();
    });

    it("closes on Escape and swallows keys that would act on the canvas underneath", async () => {
        const handles = await open();
        const seen = [];
        const key = (k, extra = {}) => ({ key: k, target: { tagName: "DIV" }, preventDefault: () => seen.push(`prevent:${k}`), stopPropagation: () => seen.push(`stop:${k}`), ...extra });
        handles.onKey(key("Delete"));
        handles.onKey(key("z", { ctrlKey: true }));
        handles.onKey(key("a"));
        assert.deepEqual(seen, ["prevent:Delete", "stop:Delete", "prevent:z", "stop:z"]);
        handles.onKey({ key: "Escape", target: { tagName: "INPUT", blur: () => seen.push("blur") }, preventDefault() {}, stopPropagation() {} });
        assert.equal(handles.overlay.attached, true, "Escape in a field only leaves the field");
        assert.ok(seen.includes("blur"));
        handles.onKey(key("Escape"));
        assert.equal(handles.overlay.attached, false);
    });

    it("reports a server error instead of an empty list", async () => {
        const original = api.fetchApi;
        api.fetchApi = async () => ({ ok: false, status: 500, json: async () => ({ error: "disk on fire" }) });
        try {
            const handles = await open();
            assert.equal(part(handles.overlay, ".ms-gallery-status").textContent, "disk on fire");
            handles.close();
        } finally {
            api.fetchApi = original;
        }
    });
});
