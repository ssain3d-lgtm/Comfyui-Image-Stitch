// Real-browser checks for the parts that need a DOM, a canvas and the
// Clipboard API: the crop editor's pointer handling and the copy action.
// Runs the real web/*.js files in Chromium via Playwright.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, cpSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import { repoRoot, stageExtension } from "./harness.mjs";

const TYPES = { ".js": "text/javascript", ".html": "text/html", ".png": "image/png", ".jpg": "image/jpeg" };

const PAGE = `<!doctype html><meta charset="utf-8"><title>Multi Stitch Images test page</title>
<script type="module">
import { app } from "./scripts/app.js";
import { openCropEditor } from "./pkg/web/crop_editor.js";
import { loadTransformedThumb } from "./pkg/web/shared.js";
await import("./pkg/web/multi_stitch.js");
const nodeType = { prototype: {} };
await app.extension.beforeRegisterNodeDef(nodeType, { name: "MultiStitchImages" });
window.__msFixtureBase = location.origin + "/fixtures";
window.__nodeType = nodeType;
window.__toasts = app.extensionManager.toast.log;
window.__openCropEditor = openCropEditor;
window.__loadTransformedThumb = loadTransformedThumb;
window.__makeNode = (filename) => ({
  pos: [0, 0], size: [420, 600], flags: {}, properties: { multi_stitch_preview: false }, graph: { setDirtyCanvas() {} }, widgets: [],
  _msImages: [{ filename, type: "input", crop: { x: 0, y: 0, w: 1, h: 1 }, rotation: 0, flip_h: false, flip_v: false }],
  _msThumbCache: new Map(), _msTransformedCache: new Map(),
});
window.__ready = true;
</script>`;

let server, origin, browser, context;

before(async () => {
    const root = stageExtension();
    writeFileSync(join(root, "index.html"), PAGE);
    cpSync(join(repoRoot, "tests", "web", "fixtures"), join(root, "fixtures"), { recursive: true });

    server = createServer((request, response) => {
        const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
        try {
            const body = readFileSync(join(root, path === "/" ? "index.html" : path));
            response.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
            response.end(body);
        } catch {
            response.writeHead(404);
            response.end();
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://localhost:${server.address().port}`;

    browser = await chromium.launch();
    context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
});

after(async () => {
    await browser?.close();
    server?.close();
});

async function openPage() {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/index.html`);
    await page.waitForFunction(() => window.__ready === true);
    return { page, errors };
}

describe("crop editor", () => {
    it("resizes by the corner handles, keeps the crop through a rotation, and applies it", async () => {
        const { page, errors } = await openPage();
        await page.evaluate(() => {
            window.__node = window.__makeNode("editor.png");
            window.__openCropEditor(window.__node, 0);
        });
        const canvas = page.locator(".ms-crop-canvas");
        await canvas.waitFor();
        const box = await canvas.boundingBox();
        assert.ok(box.width > 100 && box.height > 50, "the editor shows the 300x200 image");

        // Full-frame crop: pull the bottom-right corner in, then the top-left.
        const drag = async (from, to) => {
            await page.mouse.move(from[0], from[1]);
            await page.mouse.down();
            await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 });
            await page.mouse.move(to[0], to[1], { steps: 4 });
            await page.mouse.up();
        };
        await drag([box.x + box.width - 1, box.y + box.height - 1], [box.x + box.width * 0.6, box.y + box.height * 0.6]);
        await drag([box.x + 1, box.y + 1], [box.x + box.width * 0.1, box.y + box.height * 0.1]);

        await page.click(".rotate-right");
        assert.match(await page.locator(".dimensions").textContent(), /200 × 300/, "the editor shows the rotated size");
        await page.click(".apply");

        const item = await page.evaluate(() => window.__node._msImages[0]);
        assert.equal(item.rotation, 90);
        // {0.1, 0.1, 0.5, 0.5} in the source maps to {0.4, 0.1, 0.5, 0.5} after
        // a clockwise quarter turn (see cropSourceToView).
        const near = (a, b) => Math.abs(a - b) < 0.02;
        assert.ok(near(item.crop.x, 0.4) && near(item.crop.y, 0.1) && near(item.crop.w, 0.5) && near(item.crop.h, 0.5), JSON.stringify(item.crop));
        assert.equal(await page.locator(".ms-crop-overlay").count(), 0, "the editor closed");
        assert.deepEqual(errors, []);
        await page.close();
    });

    it("Cancel discards the edit", async () => {
        const { page } = await openPage();
        await page.evaluate(() => {
            window.__node = window.__makeNode("editor.png");
            window.__openCropEditor(window.__node, 0);
        });
        await page.locator(".ms-crop-canvas").waitFor();
        await page.click(".flip-h");
        await page.click(".cancel");
        const item = await page.evaluate(() => window.__node._msImages[0]);
        assert.equal(item.flip_h, false);
        assert.equal(await page.locator(".ms-crop-overlay").count(), 0);
        await page.close();
    });
});

describe("copy stitched result", () => {
    it("composes the originals at full size with the spacing colour and puts the PNG on the clipboard", async () => {
        const { page, errors } = await openPage();
        const r = await page.evaluate(async () => {
            const node = window.__makeNode("green.png");
            node._msImages.push({ filename: "pink.jpg", type: "input", crop: { x: 0, y: 0, w: 1, h: 1 }, rotation: 0, flip_h: false, flip_v: false });
            node.widgets = [
                { name: "direction", value: "right", options: {} }, { name: "match_image_size", value: false, options: {} },
                { name: "spacing_width", value: 2, options: {} }, { name: "spacing_color", value: "blue", options: {} },
                { name: "layout_mode", value: "strip", options: {} },
            ];
            for (const item of node._msImages) window.__loadTransformedThumb(node, item);
            await new Promise((resolve, reject) => {
                const started = Date.now();
                const timer = setInterval(() => {
                    const states = [...node._msThumbCache.values()];
                    if (states.length === 2 && states.every((s) => s.ready || s.failed)) { clearInterval(timer); resolve(); }
                    if (Date.now() - started > 10000) { clearInterval(timer); reject(new Error("thumbnails never settled")); }
                }, 20);
            });
            window.__toasts.length = 0;
            const options = [];
            window.__nodeType.prototype.getExtraMenuOptions.call(node, { graph_mouse: [200, 40] }, options);
            await options.find((o) => o?.content === "Copy stitched result").callback();
            await new Promise((resolve) => setTimeout(resolve, 200));

            const items = await navigator.clipboard.read();
            const holder = items.find((i) => i.types.includes("image/png"));
            const blob = await holder.getType("image/png");
            const bitmap = await createImageBitmap(blob);
            const c = document.createElement("canvas");
            c.width = bitmap.width; c.height = bitmap.height;
            const ctx = c.getContext("2d");
            ctx.drawImage(bitmap, 0, 0);
            const px = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
            const toast = window.__toasts[0];
            return { toast: toast && `${toast.severity}/${toast.summary}`, detail: toast?.detail, w: bitmap.width, h: bitmap.height,
                     left: px(2, 2), gap: px(6, 2), right: px(10, 2), stillCopying: node._msCopying };
        });
        // green 6×4, a 2px blue bar, pink 6×4 → 14×4.
        assert.equal(r.toast, "success/Copied");
        assert.match(r.detail, /14×4/);
        assert.deepEqual([r.w, r.h], [14, 4]);
        const near = (got, want) => got.every((v, i) => Math.abs(v - want[i]) <= 4);
        assert.ok(near(r.left, [10, 200, 40]), `left ${r.left}`);
        assert.ok(near(r.gap, [0, 0, 255]), `gap ${r.gap}`);
        assert.ok(near(r.right, [220, 30, 90]), `right ${r.right}`);
        assert.equal(r.stillCopying, false);
        assert.deepEqual(errors, []);
        await page.close();
    });
});

describe("copy original image", () => {
    async function copyThroughMenu(page, filename) {
        return page.evaluate(async (name) => {
            const node = window.__makeNode(name);
            window.__toasts.length = 0;
            const options = [];
            // graph_mouse over card 0: the list starts 148px down (toolbar row included), 130px cells.
            window.__nodeType.prototype.getExtraMenuOptions.call(node, { graph_mouse: [73, 194] }, options);
            await options[0].callback();
            await new Promise((resolve) => setTimeout(resolve, 200));
            const toast = window.__toasts[0];
            let decoded = null;
            try {
                const items = await navigator.clipboard.read();
                const holder = items.find((i) => i.types.includes("image/png"));
                if (holder) {
                    const blob = await holder.getType("image/png");
                    const bitmap = await createImageBitmap(blob);
                    const c = document.createElement("canvas");
                    c.width = bitmap.width; c.height = bitmap.height;
                    const ctx = c.getContext("2d");
                    ctx.drawImage(bitmap, 0, 0);
                    const magic = [...new Uint8Array(await blob.slice(0, 4).arrayBuffer())];
                    decoded = { w: bitmap.width, h: bitmap.height, pixel: [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3), magic };
                }
            } catch (error) { decoded = { error: String(error) }; }
            return { entry: options[0].content, toast: toast && `${toast.severity}/${toast.summary}`, detail: toast?.detail, decoded };
        }, filename);
    }

    it("puts a PNG source on the clipboard unchanged", async () => {
        const { page } = await openPage();
        const r = await copyThroughMenu(page, "green.png");
        assert.equal(r.entry, "Copy original image #1");
        assert.equal(r.toast, "success/Copied");
        assert.deepEqual(r.decoded.magic, [0x89, 0x50, 0x4e, 0x47]);
        assert.deepEqual([r.decoded.w, r.decoded.h], [6, 4]);
        assert.deepEqual(r.decoded.pixel, [10, 200, 40]);
        await page.close();
    });

    it("re-encodes a JPEG source as PNG", async () => {
        const { page } = await openPage();
        const r = await copyThroughMenu(page, "pink.jpg");
        assert.equal(r.toast, "success/Copied");
        assert.deepEqual(r.decoded.magic, [0x89, 0x50, 0x4e, 0x47]);
        const [red, green, blue] = r.decoded.pixel;
        assert.ok(Math.abs(red - 220) <= 4 && Math.abs(green - 30) <= 4 && Math.abs(blue - 90) <= 4, `pixel ${r.decoded.pixel}`);
        await page.close();
    });

    it("reports a missing source through a toast", async () => {
        const { page, errors } = await openPage();
        const r = await copyThroughMenu(page, "does-not-exist.png");
        assert.equal(r.toast, "error/Copy failed");
        assert.match(r.detail, /404/);
        assert.deepEqual(errors, []);
        await page.close();
    });
});
