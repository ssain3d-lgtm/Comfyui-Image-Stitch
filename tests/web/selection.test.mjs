// Selecting several cards and editing them as one: the list work, apart from
// the node that hosts it.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installDom, item, loadExtension, stageExtension } from "./harness.mjs";

let sel, shared;

before(async () => {
    installDom();
    const root = stageExtension();
    await loadExtension(root);
    sel = await import(pathToFileURL(join(root, "pkg", "web", "selection.js")).href);
    shared = await import(pathToFileURL(join(root, "pkg", "web", "shared.js")).href);
});

const node = (count) => ({ _msImages: Array.from({ length: count }, (_, i) => item(`f${i}.png`)) });
const names = (n) => n._msImages.map((i) => i.filename);

describe("picking cards out", () => {
    it("toggles one at a time and never hands back an index the list lost", () => {
        const n = node(4);
        assert.deepEqual(sel.selectedIndices(n), [], "nothing is selected to begin with");
        sel.toggleSelection(n, 2);
        sel.toggleSelection(n, 0);
        assert.deepEqual(sel.selectedIndices(n), [0, 2], "sorted, whatever order they were picked in");
        sel.toggleSelection(n, 2);
        assert.deepEqual(sel.selectedIndices(n), [0]);

        sel.setSelection(n, [0, 3]);
        n._msImages = n._msImages.slice(0, 2);
        assert.deepEqual(sel.selectedIndices(n), [0], "a list that shrank drops what is past its end");
        assert.equal(sel.selectionSize(n), 1);
    });

    it("selects everything, and lets it all go", () => {
        const n = node(6);
        assert.equal(sel.selectAll(n), 6);
        assert.deepEqual(sel.selectedIndices(n), [0, 1, 2, 3, 4, 5]);
        assert.equal(sel.clearSelection(n), true);
        assert.deepEqual(sel.selectedIndices(n), []);
        assert.equal(sel.clearSelection(n), false, "and says when there was nothing to clear");
    });

    it("acts on the card under the pointer when it is not part of the selection", () => {
        const n = node(4);
        sel.setSelection(n, [0, 1]);
        assert.deepEqual(sel.targetsFor(n, 1), [0, 1], "inside the selection: all of it");
        assert.deepEqual(sel.targetsFor(n, 3), [3], "outside it: just that card");
        sel.clearSelection(n);
        assert.deepEqual(sel.targetsFor(n, 2), [2], "with nothing selected: just that card");
    });
});

describe("editing several at once", () => {
    it("turns and flips them, carrying each crop through the transform", () => {
        const n = node(3);
        n._msImages[0].crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.4 };
        assert.equal(sel.rotateSelected(n, [0, 1], 90), 2);
        assert.equal(n._msImages[0].rotation, 90);
        assert.equal(n._msImages[1].rotation, 90);
        assert.equal(n._msImages[2].rotation, 0, "an image nobody selected is left alone");
        // The crop still covers the same part of the picture: turned back, it is
        // the rectangle it started as.
        assert.equal(sel.rotateSelected(n, [0], 270), 1);
        assert.equal(n._msImages[0].rotation, 0);
        const back = shared.normalizeCrop(n._msImages[0].crop);
        for (const [key, value] of Object.entries({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 })) {
            assert.ok(Math.abs(back[key] - value) < 1e-9, `${key}: ${back[key]}`);
        }

        assert.equal(sel.flipSelected(n, [0, 2], "h"), 2);
        assert.equal(n._msImages[0].flip_h, true);
        assert.equal(n._msImages[2].flip_h, true);
        assert.equal(n._msImages[1].flip_h, false);
    });

    it("crops them to a shape, centred, and leaves the ones still loading", () => {
        const n = node(3);
        const dims = { "f0.png": { w: 1000, h: 1000 }, "f1.png": { w: 2000, h: 1000 }, "f2.png": null };
        const result = sel.cropSelectedTo(n, [0, 1, 2], 9 / 16, (i) => dims[i.filename]);
        assert.deepEqual(result, { changed: 2, skipped: 1 });

        const square = shared.normalizeCrop(n._msImages[0].crop);
        assert.ok(Math.abs(square.w - 9 / 16) < 1e-9, "a square keeps its height and narrows");
        assert.equal(square.h, 1);
        assert.ok(Math.abs(square.x - (1 - 9 / 16) / 2) < 1e-9, "centred");

        const wide = shared.normalizeCrop(n._msImages[1].crop);
        assert.ok(Math.abs(wide.w - (9 / 16) / 2) < 1e-9, `a 2:1 image narrows further: ${wide.w}`);
        assert.equal(wide.h, 1);
        assert.deepEqual(shared.normalizeCrop(n._msImages[2].crop), shared.defaultCrop(), "untouched");

        // The other way round: a tall image asked for a wide shape loses height.
        const tall = node(1);
        sel.cropSelectedTo(tall, [0], 16 / 9, () => ({ w: 1000, h: 2000 }));
        const cropped = shared.normalizeCrop(tall._msImages[0].crop);
        assert.equal(cropped.w, 1);
        assert.ok(Math.abs(cropped.h - 0.5 / (16 / 9)) < 1e-9, `${cropped.h}`);
        assert.ok(Math.abs(cropped.y - (1 - cropped.h) / 2) < 1e-9, "centred");

        assert.equal(sel.centredCrop(0, 100, 1), null, "a size nobody knows yet has no crop");
        assert.equal(sel.centredCrop(100, 100, 0), null);
    });

    it("resets crops, counting only the ones that were cropped", () => {
        const n = node(3);
        n._msImages[0].crop = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
        assert.equal(sel.resetCropSelected(n, [0, 1, 2]), 1, "two were already whole");
        assert.deepEqual(shared.normalizeCrop(n._msImages[0].crop), shared.defaultCrop());
        assert.equal(sel.resetCropSelected(n, [0, 1, 2]), 0, "and nothing is left to do");
    });

    it("removes them in one step and forgets the selection they were", () => {
        const n = node(5);
        sel.setSelection(n, [1, 3]);
        assert.equal(sel.removeSelected(n, [1, 3]), 2);
        assert.deepEqual(names(n), ["f0.png", "f2.png", "f4.png"]);
        assert.deepEqual(sel.selectedIndices(n), [], "the cards it named are gone");
        assert.equal(sel.removeSelected(n, []), 0);
    });

    it("duplicates them as a run, and refuses rather than dropping half the copies", () => {
        const n = node(4);
        assert.equal(sel.duplicateSelected(n, [0, 2]), 2);
        assert.deepEqual(names(n), ["f0.png", "f1.png", "f2.png", "f0.png", "f2.png", "f3.png"],
            "the copies sit after the last of the originals");
        assert.deepEqual(sel.selectedIndices(n), [3, 4], "and the copies are what is selected now");
        n._msImages[3].crop.w = 0.25;
        assert.equal(shared.normalizeCrop(n._msImages[0].crop).w, 1, "each copy crops on its own");

        const full = node(shared.MAX_IMAGES);
        assert.equal(sel.duplicateSelected(full, [0, 1]), -1, "no room for both, so neither");
        assert.equal(full._msImages.length, shared.MAX_IMAGES);
    });

    it("moves them to either end, keeping their order and following them", () => {
        const n = node(5);
        assert.equal(sel.moveSelectedTo(n, [1, 3], "start"), 2);
        assert.deepEqual(names(n), ["f1.png", "f3.png", "f0.png", "f2.png", "f4.png"]);
        assert.deepEqual(sel.selectedIndices(n), [0, 1]);

        assert.equal(sel.moveSelectedTo(n, [0, 1], "end"), 2);
        assert.deepEqual(names(n), ["f0.png", "f2.png", "f4.png", "f1.png", "f3.png"]);
        assert.deepEqual(sel.selectedIndices(n), [3, 4]);

        assert.equal(sel.moveSelectedTo(n, [3, 4], "end"), 0, "already there, so nothing happens");
        assert.equal(sel.moveSelectedTo(n, [0, 1, 2, 3, 4], "start"), 0, "and everything is not a move");
    });

    it("carries a whole selection to a slot when one of them is dragged", () => {
        const n = node(5);
        assert.equal(sel.reorderSelectionTo(n, [0, 1], 4), 2);
        assert.deepEqual(names(n), ["f2.png", "f3.png", "f0.png", "f1.png", "f4.png"],
            "dropped into the gap the slot names, counted in the list they left");
        assert.deepEqual(sel.selectedIndices(n), [2, 3]);
        assert.equal(sel.reorderSelectionTo(n, [2, 3], 2), 0, "a drop where they already are changes nothing");
    });
});
