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
import { drawImageScaled, loadTransformedThumb } from "./pkg/web/shared.js";
import { openFramePicker } from "./pkg/web/frame_picker.js";
await import("./pkg/web/multi_stitch.js");
const nodeType = { prototype: {} };
await app.extension.beforeRegisterNodeDef(nodeType, { name: "MultiStitchImages" });
window.__msFixtureBase = location.origin + "/fixtures";
window.__nodeType = nodeType;
window.__toasts = app.extensionManager.toast.log;
window.__openCropEditor = openCropEditor;
window.__loadTransformedThumb = loadTransformedThumb;
window.__drawImageScaled = drawImageScaled;
window.__openFramePicker = openFramePicker;
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

    it("resizes by an edge bar and applies only that side", async () => {
        const { page, errors } = await openPage();
        await page.evaluate(() => {
            window.__node = window.__makeNode("editor.png");
            window.__openCropEditor(window.__node, 0);
        });
        const canvas = page.locator(".ms-crop-canvas");
        await canvas.waitFor();
        const box = await canvas.boundingBox();

        // The right edge bar, pulled in to 60% of the width: nothing else moves.
        await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 4 });
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 4 });
        await page.mouse.up();
        await page.click(".apply");

        const item = await page.evaluate(() => window.__node._msImages[0]);
        const near = (a, b) => Math.abs(a - b) < 0.03;
        assert.ok(near(item.crop.x, 0) && near(item.crop.y, 0) && near(item.crop.w, 0.6) && near(item.crop.h, 1),
            JSON.stringify(item.crop));
        assert.deepEqual(errors, []);
        await page.close();
    });

    it("counts the crop in pixels while it is dragged, and agrees with what is applied", async () => {
        const { page, errors } = await openPage();
        await page.evaluate(() => {
            window.__node = window.__makeNode("editor.png");
            window.__openCropEditor(window.__node, 0);
        });
        const canvas = page.locator(".ms-crop-canvas");
        await canvas.waitFor();
        const box = await canvas.boundingBox();
        const header = () => page.locator(".dimensions").textContent();
        assert.equal(await header(), "300 × 200", "an uncropped image is one size, not two");

        // The right edge bar, pulled in to 60% of the width.
        await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 4 });
        const during = await header();
        assert.match(during, /^300 × 200 → \d+ × 200$/, `live while the edge is held: ${during}`);
        await page.mouse.up();

        const shown = await header();
        const [, width, height] = shown.match(/→ (\d+) × (\d+)/);
        assert.ok(Math.abs(Number(width) - 180) <= 6, `60% of 300 is about 180, not ${width}`);
        await page.click(".apply");

        // The number the header showed is the number the crop actually is.
        const crop = await page.evaluate(() => window.__node._msImages[0].crop);
        assert.equal(Number(width), Math.round(crop.w * 300));
        assert.equal(Number(height), Math.round(crop.h * 200));
        assert.deepEqual(errors, []);
        await page.close();
    });

    it("zooms around the pointer, and crops in the pixels the zoom shows", async () => {
        const { page, errors } = await openPage();
        await page.evaluate(() => {
            window.__node = window.__makeNode("editor.png");
            window.__openCropEditor(window.__node, 0);
        });
        const canvas = page.locator(".ms-crop-canvas");
        await canvas.waitFor();
        const box = await canvas.boundingBox();
        const view = () => page.evaluate(() => window.__node._msEditor.view());
        // The image pixel a screen point is showing, worked out from the view.
        const imageAt = (v, x, y) => ({
            x: v.x + (x - box.x) / box.width * v.w,
            y: v.y + (y - box.y) / box.height * v.h,
        });
        assert.equal(await page.locator(".zoom-level").textContent(), "100%");

        const at = [box.x + box.width * 0.25, box.y + box.height * 0.75];
        const before = await view();
        const was = imageAt(before, ...at);
        await page.mouse.move(...at);
        await page.mouse.wheel(0, -120);
        const after = await view();
        assert.ok(after.w < before.w, `the wheel zoomed in: ${after.w} < ${before.w}`);
        const now = imageAt(after, ...at);
        assert.ok(Math.abs(now.x - was.x) < 1 && Math.abs(now.y - was.y) < 1,
            `the pixel under the pointer stayed put: ${JSON.stringify([was, now])}`);

        await page.click(".zoom-fit");
        assert.equal(await page.locator(".zoom-level").textContent(), "100%", "Fit shows the whole image again");

        // Pull the bottom-right corner to the middle at 1:1, zoom to 225%, then
        // pull it 45 more screen pixels: that is 20 image pixels across and 20
        // down, not 45 of either.
        const drag = async (from, to) => {
            await page.mouse.move(from[0], from[1]);
            await page.mouse.down();
            await page.mouse.move(to[0], to[1], { steps: 4 });
            await page.mouse.up();
        };
        await drag([box.x + box.width - 1, box.y + box.height - 1], [box.x + box.width / 2, box.y + box.height / 2]);
        await page.click(".zoom-in");
        await page.click(".zoom-in");
        assert.equal(await page.locator(".zoom-level").textContent(), "225%");
        await drag([box.x + box.width / 2, box.y + box.height / 2], [box.x + box.width / 2 - 45, box.y + box.height / 2 - 45]);
        await page.click(".apply");

        const item = await page.evaluate(() => window.__node._msImages[0]);
        const near = (a, b) => Math.abs(a - b) < 0.02;
        assert.ok(near(item.crop.w, 130 / 300) && near(item.crop.h, 80 / 200), JSON.stringify(item.crop));
        assert.deepEqual(errors, []);
        await page.close();
    });

    it("pans with the middle button and with space held, leaving the crop alone", async () => {
        const { page, errors } = await openPage();
        await page.evaluate(() => {
            window.__node = window.__makeNode("editor.png");
            window.__openCropEditor(window.__node, 0);
        });
        const canvas = page.locator(".ms-crop-canvas");
        await canvas.waitFor();
        const box = await canvas.boundingBox();
        const view = () => page.evaluate(() => window.__node._msEditor.view());

        await page.click(".zoom-in");
        await page.click(".zoom-in");
        const start = await view();
        const centre = [box.x + box.width / 2, box.y + box.height / 2];

        await page.mouse.move(...centre);
        await page.mouse.down({ button: "middle" });
        await page.mouse.move(centre[0] + 60, centre[1] + 40, { steps: 4 });
        await page.mouse.up({ button: "middle" });
        const panned = await view();
        assert.ok(Math.abs(panned.x - (start.x - 60 / box.width * start.w)) < 1, `x: ${panned.x} from ${start.x}`);
        assert.ok(Math.abs(panned.y - (start.y - 40 / box.height * start.h)) < 1, `y: ${panned.y} from ${start.y}`);
        assert.equal(panned.w, start.w, "a pan does not zoom");

        // Space with the left button, back the other way.
        await page.evaluate(() => document.querySelector(".ms-crop-overlay").focus());
        await page.keyboard.down("Space");
        await page.mouse.move(...centre);
        await page.mouse.down();
        await page.mouse.move(centre[0] - 60, centre[1] - 40, { steps: 4 });
        await page.mouse.up();
        await page.keyboard.up("Space");
        const back = await view();
        assert.ok(Math.abs(back.x - start.x) < 1 && Math.abs(back.y - start.y) < 1,
            `back where it started: ${JSON.stringify([start, back])}`);

        await page.click(".zoom-fit");
        assert.deepEqual(await view(), { x: 0, y: 0, w: 300, h: 200 });
        await page.click(".apply");
        assert.deepEqual(await page.evaluate(() => window.__node._msImages[0].crop), { x: 0, y: 0, w: 1, h: 1 },
            "none of that moved the crop");
        assert.deepEqual(errors, []);
        await page.close();
    });

    it("copies the picture itself on right-click, never the grid drawn over it", async () => {
        const { page, errors } = await openPage();
        await page.evaluate(() => {
            window.__node = window.__makeNode("editor.png");
            window.__openCropEditor(window.__node, 0);
        });
        const canvas = page.locator(".ms-crop-canvas");
        await canvas.waitFor();
        const box = await canvas.boundingBox();

        // The browser's own menu would hand over the canvas as drawn: the
        // darkened surround, the white outline and the thirds grid.
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
        assert.deepEqual(
            await page.locator(".ms-crop-menu button").allTextContents(),
            ["Copy crop to clipboard", "Copy whole image to clipboard"],
        );

        await page.locator(".ms-crop-menu button", { hasText: "Copy whole image" }).click();
        await page.waitForFunction(() => /copied/.test(document.querySelector(".ms-crop-hint").textContent));
        const whole = await page.evaluate(async () => {
            const items = await navigator.clipboard.read();
            const blob = await items.find((i) => i.types.includes("image/png")).getType("image/png");
            const bitmap = await createImageBitmap(blob);
            const shot = document.createElement("canvas");
            shot.width = bitmap.width;
            shot.height = bitmap.height;
            shot.getContext("2d").drawImage(bitmap, 0, 0);
            // The same file, decoded on its own: the copy has to equal it pixel
            // for pixel, which nothing drawn over the picture could survive.
            const source = new Image();
            source.src = `${window.__msFixtureBase}/editor.png`;
            await source.decode();
            const want = document.createElement("canvas");
            want.width = source.naturalWidth;
            want.height = source.naturalHeight;
            want.getContext("2d").drawImage(source, 0, 0);
            const a = shot.getContext("2d").getImageData(0, 0, shot.width, shot.height).data;
            const b = want.getContext("2d").getImageData(0, 0, want.width, want.height).data;
            let differing = 0;
            if (a.length === b.length) {
                for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
            }
            return { w: bitmap.width, h: bitmap.height, source: [want.width, want.height], differing, same: a.length === b.length };
        });
        assert.deepEqual([whole.w, whole.h], whole.source, "the whole image, at its own size");
        assert.ok(whole.same, "same number of samples");
        assert.equal(whole.differing, 0, "not one pixel of the editor's overlay came with it");

        // And a crop copies only the crop, at the size the header counts.
        await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 4 });
        await page.mouse.up();
        const [, wanted, high] = (await page.locator(".dimensions").textContent()).match(/→ (\d+) × (\d+)/);
        await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2, { button: "right" });
        await page.locator(".ms-crop-menu button", { hasText: "Copy crop" }).click();
        await page.waitForFunction(() => /Crop copied/.test(document.querySelector(".ms-crop-hint").textContent));
        const crop = await page.evaluate(async () => {
            const items = await navigator.clipboard.read();
            const blob = await items.find((i) => i.types.includes("image/png")).getType("image/png");
            const bitmap = await createImageBitmap(blob);
            return [bitmap.width, bitmap.height];
        });
        assert.deepEqual(crop, [Number(wanted), Number(high)], "exactly what the header said the crop measures");
        assert.deepEqual(errors, []);
        await page.close();
    });

    it("paints a blur only where the brush goes, and keeps it through a rotation", async () => {
        const { page, errors } = await openPage();
        await page.evaluate(() => {
            // A checkerboard, because a blur is invisible on a gradient.
            window.__node = window.__makeNode("check.png");
            window.__openCropEditor(window.__node, 0);
        });
        const canvas = page.locator(".ms-crop-canvas");
        await canvas.waitFor();
        assert.equal(await page.locator(".ms-crop-brush").isVisible(), false,
            "the brush row belongs to the blur tool, not to cropping");
        await page.click(".tool-blur");
        const box = await canvas.boundingBox();

        const spread = () => page.evaluate(() => {
            const target = document.querySelector(".ms-crop-canvas");
            const ctx = target.getContext("2d");
            const deviation = (fx, fy) => {
                const data = ctx.getImageData(
                    Math.round(target.width * fx), Math.round(target.height * fy),
                    Math.round(target.width * 0.1), Math.round(target.height * 0.1),
                ).data;
                const greys = [];
                for (let i = 0; i < data.length; i += 4) greys.push(data[i]);
                const mean = greys.reduce((a, b) => a + b, 0) / greys.length;
                return Math.sqrt(greys.reduce((a, b) => a + (b - mean) ** 2, 0) / greys.length);
            };
            return { middle: deviation(0.45, 0.45), corner: deviation(0.15, 0.15) };
        });
        const before = await spread();
        assert.ok(before.middle > 90, `the checkerboard really is sharp there (${before.middle})`);

        // Straight across the middle, well clear of the corner sampled below.
        await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 6 });
        await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.5, { steps: 6 });
        await page.mouse.up();

        const after = await spread();
        assert.ok(after.middle < before.middle * 0.6, `the stroke softened it (${before.middle} → ${after.middle})`);
        assert.ok(Math.abs(after.corner - before.corner) < 3, `and left the rest alone (${before.corner} → ${after.corner})`);

        // Strokes ride along with a quarter turn, as the crop does.
        await page.click(".rotate-right");
        const turned = await page.evaluate(() => {
            const target = document.querySelector(".ms-crop-canvas");
            const ctx = target.getContext("2d");
            const data = ctx.getImageData(
                Math.round(target.width * 0.45), Math.round(target.height * 0.45),
                Math.round(target.width * 0.1), Math.round(target.height * 0.1),
            ).data;
            const greys = [];
            for (let i = 0; i < data.length; i += 4) greys.push(data[i]);
            const mean = greys.reduce((a, b) => a + b, 0) / greys.length;
            return Math.sqrt(greys.reduce((a, b) => a + (b - mean) ** 2, 0) / greys.length);
        });
        assert.ok(turned < before.middle * 0.6, `still blurred after the turn (${turned})`);

        await page.click(".apply");
        const item = await page.evaluate(() => window.__node._msImages[0]);
        assert.equal(item.rotation, 90);
        assert.equal(item.blur.strokes.length, 1);
        assert.ok(item.blur.strength > 0 && item.blur.strokes[0].r > 0);
        assert.ok(item.blur.strokes[0].pts.length >= 2, "the drag became a polyline, not one dot");
        for (const [x, y] of item.blur.strokes[0].pts) {
            assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1, `${x},${y} is inside the picture`);
        }
        assert.deepEqual(errors, []);
        await page.close();
    });

    it("takes a stroke back with Ctrl+Z and drops them all with Clear blur", async () => {
        const { page, errors } = await openPage();
        await page.evaluate(() => {
            window.__node = window.__makeNode("check.png");
            window.__openCropEditor(window.__node, 0);
        });
        const canvas = page.locator(".ms-crop-canvas");
        await canvas.waitFor();
        await page.click(".tool-blur");
        const box = await canvas.boundingBox();
        const dab = async (fx) => {
            await page.mouse.move(box.x + box.width * fx, box.y + box.height * 0.5);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width * (fx + 0.08), box.y + box.height * 0.5, { steps: 4 });
            await page.mouse.up();
        };
        await dab(0.2);
        await dab(0.5);
        await page.keyboard.press("Control+z");
        await page.click(".apply");
        assert.equal((await page.evaluate(() => window.__node._msImages[0].blur)).strokes.length, 1,
            "Ctrl+Z took back the second stroke, not both");

        await page.evaluate(() => window.__openCropEditor(window.__node, 0));
        await canvas.waitFor();
        await page.click(".tool-blur");
        assert.equal(await page.locator(".ms-crop-brush").isVisible(), true, "the brush row shows with the tool");
        await page.click(".blur-clear");
        await page.click(".apply");
        assert.equal(await page.evaluate(() => "blur" in window.__node._msImages[0]), false,
            "with no strokes left the item carries no blur at all");
        assert.deepEqual(errors, []);
        await page.close();
    });

    it("walks the list without closing, keeping an edit only where one was made", async () => {
        const { page, errors } = await openPage();
        await page.evaluate(() => {
            window.__node = window.__makeNode("editor.png");
            const card = (filename) => ({
                filename, type: "input", crop: { x: 0, y: 0, w: 1, h: 1 },
                rotation: 0, flip_h: false, flip_v: false,
            });
            window.__node._msImages = [card("editor.png"), card("check.png"), card("green.png")];
            window.__openCropEditor(window.__node, 0);
        });
        const canvas = page.locator(".ms-crop-canvas");
        await canvas.waitFor();
        const title = () => page.locator(".ms-crop-title").textContent();
        assert.equal(await title(), "Edit image 1 of 3");
        assert.equal(await page.locator(".step-prev").isDisabled(), true, "nothing before the first");

        // Trim the first image, then move on: the edit goes in by itself.
        const box = await canvas.boundingBox();
        await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 4 });
        await page.mouse.up();
        await page.click(".step-next");
        await page.waitForFunction(() => /image 2/.test(document.querySelector(".ms-crop-title").textContent));

        assert.equal(await page.locator(".ms-crop-overlay").count(), 1, "the editor never closed");
        const first = await page.evaluate(() => window.__node._msImages[0].crop);
        assert.ok(Math.abs(first.w - 0.6) < 0.03, `the trim was kept: ${JSON.stringify(first)}`);
        assert.equal(await page.locator(".step-prev").isDisabled(), false);

        // The arrow keys do the same, and the last image has nothing after it.
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(() => /image 3/.test(document.querySelector(".ms-crop-title").textContent));
        assert.equal(await page.locator(".step-next").isDisabled(), true);
        await page.keyboard.press("ArrowLeft");
        await page.waitForFunction(() => /image 2/.test(document.querySelector(".ms-crop-title").textContent));

        // Walking past an image without touching it leaves it alone, so
        // browsing the list costs no undo steps.
        assert.deepEqual(await page.evaluate(() => window.__node._msImages[1].crop), { x: 0, y: 0, w: 1, h: 1 });
        assert.deepEqual(await page.evaluate(() => window.__node._msImages[2].crop), { x: 0, y: 0, w: 1, h: 1 });

        // And the second image is really the one on the canvas now.
        assert.equal(await page.evaluate(() => window.__node._msEditor.index()), 1);
        assert.equal(await page.locator(".dimensions").textContent(), "300 × 200");
        assert.deepEqual(errors, []);
        await page.close();
    });

    it("closes on Escape without applying", async () => {
        const { page, errors } = await openPage();
        await page.evaluate(() => {
            window.__node = window.__makeNode("editor.png");
            window.__openCropEditor(window.__node, 0);
        });
        await page.locator(".ms-crop-canvas").waitFor();
        await page.click(".flip-h");
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.querySelectorAll(".ms-crop-overlay").length === 0);
        const item = await page.evaluate(() => window.__node._msImages[0]);
        assert.equal(item.flip_h, false, "Escape discards, like Cancel");
        assert.deepEqual(errors, []);
        await page.close();
    });

    it("asks before a click beside the panel throws an edit away", async () => {
        const { page, errors } = await openPage();
        const open = async () => {
            await page.evaluate(() => {
                window.__node ||= window.__makeNode("editor.png");
                window.__openCropEditor(window.__node, 0);
            });
            await page.locator(".ms-crop-canvas").waitFor();
        };
        await open();
        // Nothing edited yet: the backdrop closes it without a word.
        await page.mouse.click(4, 4);
        await page.waitForFunction(() => document.querySelectorAll(".ms-crop-overlay").length === 0);

        await open();
        const asked = [];
        page.on("dialog", async (dialog) => {
            asked.push(dialog.message());
            if (asked.length === 1) await dialog.dismiss();
            else await dialog.accept();
        });
        await page.click(".rotate-right");
        await page.mouse.click(4, 4);
        assert.equal(asked.length, 1, "it asked");
        assert.match(asked[0], /Discard/);
        assert.equal(await page.locator(".ms-crop-overlay").count(), 1, "answered no, so the edit is still open");

        await page.mouse.click(4, 4);
        await page.waitForFunction(() => document.querySelectorAll(".ms-crop-overlay").length === 0);
        const item = await page.evaluate(() => window.__node._msImages[0]);
        assert.equal(item.rotation, 0, "answered yes, so the rotation went");
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

describe("high-quality scaling", () => {
    it("reduces a fine checkerboard to an even grey instead of aliasing", async () => {
        const { page, errors } = await openPage();
        const r = await page.evaluate(() => {
            const source = document.createElement("canvas");
            source.width = source.height = 1024;
            const sctx = source.getContext("2d");
            const pattern = sctx.createImageData(1024, 1024);
            for (let i = 0; i < pattern.data.length; i += 4) {
                const p = i / 4;
                const on = ((p % 1024) + Math.floor(p / 1024)) % 2 === 0;
                pattern.data[i] = pattern.data[i + 1] = pattern.data[i + 2] = on ? 255 : 0;
                pattern.data[i + 3] = 255;
            }
            sctx.putImageData(pattern, 0, 0);

            const out = document.createElement("canvas");
            out.width = out.height = 64;
            const ctx = out.getContext("2d");
            window.__drawImageScaled(ctx, source, 0, 0, 1024, 1024, 0, 0, 64, 64);
            const data = ctx.getImageData(0, 0, 64, 64).data;
            let min = 255, max = 0;
            for (let i = 0; i < data.length; i += 4) { min = Math.min(min, data[i]); max = Math.max(max, data[i]); }
            return { min, max, quality: ctx.imageSmoothingQuality };
        });
        assert.equal(errors.length, 0, errors.join("\n"));
        assert.equal(r.quality, "high");
        // Every output pixel averages a 16×16 block: 128 within rounding.
        assert.ok(r.min >= 112 && r.max <= 144, `expected an even grey, got ${r.min}..${r.max}`);
    });
});

describe("frame picker", () => {
    it("captures the frame being shown, at native size, and steps by one frame", async (t) => {
        const { page, errors } = await openPage();
        const supported = await page.evaluate(() => typeof MediaRecorder !== "undefined"
            && MediaRecorder.isTypeSupported("video/webm;codecs=vp8"));
        if (!supported) {
            // A skip on CI would quietly remove the frame picker's only
            // end-to-end check, so there it is a failure instead.
            assert.ok(!process.env.CI, "this Chromium cannot record WebM: the frame picker went untested");
            t.skip("this Chromium cannot record WebM");
            return;
        }
        const r = await page.evaluate(async () => {
            // Two seconds of video: red, then blue from 1.0s, at 10 fps.
            const source = document.createElement("canvas");
            source.width = 320;
            source.height = 180;
            const sctx = source.getContext("2d");
            const paint = (colour) => { sctx.fillStyle = colour; sctx.fillRect(0, 0, 320, 180); };
            paint("#ff0000");
            const stream = source.captureStream(10);
            const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
            const chunks = [];
            recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
            const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
            recorder.start(100);
            const started = performance.now();
            await new Promise((resolve) => {
                const timer = setInterval(() => {
                    const elapsed = performance.now() - started;
                    paint(elapsed >= 1000 ? "#0000ff" : "#ff0000");
                    if (elapsed >= 2000) { clearInterval(timer); resolve(); }
                }, 50);
            });
            recorder.stop();
            await stopped;
            const url = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));

            const node = { _msImages: [], _msVideos: [], graph: { setDirtyCanvas() {} } };
            const entry = { kind: "video", filename: "clip.webm", name: "clip.webm", url };
            const captured = [];
            const picker = window.__openFramePicker(node, entry, {
                onCapture: (canvas, time) => {
                    const d = canvas.getContext("2d").getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
                    captured.push({ time, width: canvas.width, height: canvas.height, rgb: [d[0], d[1], d[2]] });
                    return { time };
                },
            });
            const wait = (test, ms = 8000) => new Promise((resolve, reject) => {
                const startedAt = Date.now();
                const timer = setInterval(() => {
                    if (test()) { clearInterval(timer); resolve(); }
                    else if (Date.now() - startedAt > ms) { clearInterval(timer); reject(new Error("timed out: " + test)); }
                }, 20);
            });
            const video = picker.video;
            await wait(() => video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 1.5
                && (!picker.state.hasFrameCallback || (picker.state.probed && !picker.state.probing)));
            const detected = picker.frameDuration();
            const seek = async (time) => {
                const done = new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
                picker.seekTo(time);
                await done;
                await new Promise((resolve) => setTimeout(resolve, 150));
            };
            await seek(1.6);
            await picker.capture();
            await seek(0.4);
            await picker.capture();
            const before = picker.currentTime();
            const stepped = new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
            picker.step(1);
            await stepped;
            await new Promise((resolve) => setTimeout(resolve, 150));
            const after = picker.currentTime();
            const overlayCount = document.querySelectorAll(".ms-video-overlay").length;
            picker.close(false);
            return {
                captured, before, after, frameDuration: detected, duration: video.duration,
                overlayCount, overlaysAfter: document.querySelectorAll(".ms-video-overlay").length,
                shots: picker.overlay.querySelectorAll(".shot").length,
            };
        });
        assert.equal(errors.length, 0, errors.join("\n"));
        assert.equal(r.captured.length, 2, JSON.stringify(r));
        assert.deepEqual([r.captured[0].width, r.captured[0].height], [320, 180], "native size");
        const [blue, red] = r.captured.map((c) => c.rgb);
        assert.ok(blue[2] > 150 && blue[0] < 100, `expected blue at 1.6s, got ${blue}`);
        assert.ok(red[0] > 150 && red[2] < 100, `expected red at 0.4s, got ${red}`);
        assert.ok(r.after > r.before, `one frame forward moved ${r.before} → ${r.after}`);
        assert.ok(r.after - r.before < 0.35, `a single step, not a jump: ${r.after - r.before}`);
        assert.ok(Math.abs(r.frameDuration - 0.1) < 0.03, `10 fps detected while probing, got ${1 / r.frameDuration}`);
        assert.equal(r.overlayCount, 1);
        assert.equal(r.overlaysAfter, 0, "closed");
        assert.equal(r.shots, 2, "each capture shows in the strip");
    });
});

describe("copy one image", () => {
    async function copyThroughMenu(page, filename, entry = "Copy image #1 to clipboard", edits = null) {
        return page.evaluate(async ({ name, entry, edits }) => {
            const node = window.__makeNode(name);
            if (edits) Object.assign(node._msImages[0], edits);
            window.__toasts.length = 0;
            const options = [];
            // graph_mouse over card 0: the list starts 148px down (toolbar row included), 130px cells.
            window.__nodeType.prototype.getExtraMenuOptions.call(node, { graph_mouse: [73, 194] }, options);
            const copy = options.find((o) => o?.content === entry);
            if (!copy) return { entries: options.map((o) => o?.content).filter(Boolean) };
            await copy.callback();
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
            return {
                entry: copy.content, toast: toast && `${toast.severity}/${toast.summary}`,
                detail: toast?.detail, decoded,
                entries: options.map((o) => o?.content).filter(Boolean),
            };
        }, { name: filename, entry, edits });
    }

    it("copies an untouched image whole, as PNG", async () => {
        const { page } = await openPage();
        const r = await copyThroughMenu(page, "green.png");
        assert.equal(r.toast, "success/Copied");
        assert.deepEqual(r.decoded.magic, [0x89, 0x50, 0x4e, 0x47]);
        assert.deepEqual([r.decoded.w, r.decoded.h], [6, 4]);
        assert.deepEqual(r.decoded.pixel, [10, 200, 40]);
        // With nothing edited, the file and the edit are the same picture, so
        // the menu does not offer to copy it twice.
        assert.equal(r.entries.includes("Copy image #1 as uploaded"), false);
        await page.close();
    });

    it("copies what the card shows, not the file it came from", async () => {
        const { page } = await openPage();
        // A quarter turn makes the 300x200 gradient 200x300, and the crop is
        // measured against that, as the editor and the server measure it: the
        // right-hand 40% of 200 is 80 wide, the full 300 tall.
        const edits = { crop: { x: 0.6, y: 0, w: 0.4, h: 1 }, rotation: 90 };
        const r = await copyThroughMenu(page, "editor.png", "Copy image #1 to clipboard", edits);
        assert.equal(r.toast, "success/Copied");
        assert.deepEqual([r.decoded.w, r.decoded.h], [80, 300]);
        assert.match(r.detail, /80×300/);
        assert.match(r.detail, /as edited/);
        await page.close();
    });

    it("still offers the untouched file beside it", async () => {
        const { page } = await openPage();
        const edits = { crop: { x: 0.6, y: 0, w: 0.4, h: 1 }, rotation: 90 };
        const r = await copyThroughMenu(page, "editor.png", "Copy image #1 as uploaded", edits);
        assert.equal(r.toast, "success/Copied");
        assert.deepEqual([r.decoded.w, r.decoded.h], [300, 200], "the file as uploaded, crop and turn ignored");
        assert.match(r.detail, /as uploaded/);
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
        assert.match(r.detail, /does-not-exist\.png/);
        assert.deepEqual(errors, []);
        await page.close();
    });
});
