// Selecting several cards, and the edits that then act on all of them.
//
// Everything here is pure list work: it reads and writes node._msImages and
// node._msSelected and nothing else, so the caller decides when to commit (one
// history entry per batch) and how to tell the user what happened. Each edit
// returns how many images it changed, or -1 when it could not run.
import { defaultCrop, MAX_IMAGES, normalizeCrop, normalizeTransform, cropSourceToView, cropViewToSource } from "./shared.js";

function imagesOf(node) {
    return Array.isArray(node?._msImages) ? node._msImages : [];
}

// The selection as a sorted list of indices that still exist. Reading it
// filters, so a list that shrank under the selection cannot hand out an index
// past the end.
export function selectedIndices(node) {
    const count = imagesOf(node).length;
    const raw = node?._msSelected instanceof Set ? [...node._msSelected] : [];
    return raw.filter((index) => Number.isInteger(index) && index >= 0 && index < count).sort((a, b) => a - b);
}

export function selectionSize(node) {
    return selectedIndices(node).length;
}

export function isSelected(node, index) {
    return node?._msSelected instanceof Set && node._msSelected.has(index);
}

export function clearSelection(node) {
    if (!node) return false;
    const had = selectionSize(node) > 0;
    node._msSelected = new Set();
    return had;
}

export function setSelection(node, indices) {
    if (!node) return;
    node._msSelected = new Set(indices.filter((i) => Number.isInteger(i) && i >= 0 && i < imagesOf(node).length));
}

// A card's number is its checkbox: clicking it adds or drops that one. No
// modifier decides it, because the frontend does not pass modifier keys
// through to a node's onMouseDown — every one of them arrives false.
export function toggleSelection(node, index) {
    if (!node || index < 0 || index >= imagesOf(node).length) return false;
    node._msSelected = node._msSelected instanceof Set ? node._msSelected : new Set();
    if (node._msSelected.has(index)) node._msSelected.delete(index);
    else node._msSelected.add(index);
    return true;
}

export function selectAll(node) {
    const count = imagesOf(node).length;
    setSelection(node, Array.from({ length: count }, (_, i) => i));
    return count;
}

// After a structural change, the selection is expressed in indices that no
// longer mean the same cards. The caller passes the new positions it wants
// selected; anything else drops it.
export function remapSelection(node, indices) {
    setSelection(node, indices);
}

// The images a batch edit acts on: the selection, or just the card the action
// was invoked on when nothing is selected.
export function targetsFor(node, index) {
    const selected = selectedIndices(node);
    if (selected.includes(index)) return selected;
    return index >= 0 && index < imagesOf(node).length ? [index] : selected;
}

export function rotateSelected(node, targets, delta) {
    const items = imagesOf(node);
    let changed = 0;
    for (const index of targets) {
        const item = items[index];
        if (!item) continue;
        const previous = normalizeTransform(item);
        // Carry the crop through the turn instead of dropping it, the way the
        // editor does: back to the source, then forward into the new view.
        const source = cropViewToSource(normalizeCrop(item.crop), previous);
        const next = normalizeTransform({ ...previous, rotation: previous.rotation + delta });
        item.rotation = next.rotation;
        item.crop = normalizeCrop(cropSourceToView(source, next));
        changed += 1;
    }
    return changed;
}

export function flipSelected(node, targets, axis) {
    const key = axis === "v" ? "flip_v" : "flip_h";
    const items = imagesOf(node);
    let changed = 0;
    for (const index of targets) {
        const item = items[index];
        if (!item) continue;
        const previous = normalizeTransform(item);
        const source = cropViewToSource(normalizeCrop(item.crop), previous);
        const next = normalizeTransform({ ...previous, [key]: !previous[key] });
        item.flip_h = next.flip_h;
        item.flip_v = next.flip_v;
        item.crop = normalizeCrop(cropSourceToView(source, next));
        changed += 1;
    }
    return changed;
}

export function resetCropSelected(node, targets) {
    const items = imagesOf(node);
    let changed = 0;
    for (const index of targets) {
        const item = items[index];
        if (!item) continue;
        const crop = normalizeCrop(item.crop);
        if (crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1) continue;
        item.crop = defaultCrop();
        changed += 1;
    }
    return changed;
}

// The largest crop of `ratio` that fits, centred. The crop is stored against
// the transformed image, so the ratio is measured there too — which is what
// someone picking "9:16" is looking at.
export function centredCrop(viewWidth, viewHeight, ratio) {
    const w = Number(viewWidth) || 0;
    const h = Number(viewHeight) || 0;
    const target = Number(ratio) || 0;
    if (w <= 0 || h <= 0 || target <= 0) return null;
    const view = w / h;
    const cw = view > target ? target / view : 1;
    const ch = view > target ? 1 : view / target;
    return normalizeCrop({ x: (1 - cw) / 2, y: (1 - ch) / 2, w: cw, h: ch });
}

// `dimsOf` gives the transformed size of an image, or null while it is still
// loading — those are left alone and counted as skipped.
export function cropSelectedTo(node, targets, ratio, dimsOf) {
    const items = imagesOf(node);
    let changed = 0;
    let skipped = 0;
    for (const index of targets) {
        const item = items[index];
        if (!item) continue;
        const dims = dimsOf(item);
        const crop = dims ? centredCrop(dims.w, dims.h, ratio) : null;
        if (!crop) {
            skipped += 1;
            continue;
        }
        item.crop = crop;
        changed += 1;
    }
    return { changed, skipped };
}

export function removeSelected(node, targets) {
    const items = imagesOf(node);
    const drop = new Set(targets);
    const kept = items.filter((_, index) => !drop.has(index));
    const removed = items.length - kept.length;
    if (!removed) return 0;
    node._msImages = kept;
    clearSelection(node);
    return removed;
}

// Copies of each selected image, as a run right after the last of them, so a
// duplicated group stays a group. Refuses rather than truncating: a batch that
// silently dropped half its copies would be worse than one that did nothing.
export function duplicateSelected(node, targets) {
    const items = imagesOf(node);
    const picked = targets.map((index) => items[index]).filter(Boolean);
    if (!picked.length) return 0;
    if (items.length + picked.length > MAX_IMAGES) return -1;
    const copies = picked.map((item) => {
        const copy = { ...item, crop: { ...normalizeCrop(item.crop) } };
        if (item.source) copy.source = { ...item.source };
        return copy;
    });
    const at = Math.max(...targets) + 1;
    items.splice(at, 0, ...copies);
    remapSelection(node, copies.map((_, i) => at + i));
    return copies.length;
}

// The selected images as one run at the front or the back, keeping the order
// they were in. The selection follows them.
export function moveSelectedTo(node, targets, where) {
    const items = imagesOf(node);
    const picked = targets.map((index) => items[index]).filter(Boolean);
    if (!picked.length || picked.length === items.length) return 0;
    const rest = items.filter((item) => !picked.includes(item));
    const next = where === "start" ? [...picked, ...rest] : [...rest, ...picked];
    if (next.every((item, index) => item === items[index])) return 0;
    node._msImages = next;
    const at = where === "start" ? 0 : rest.length;
    remapSelection(node, picked.map((_, i) => at + i));
    return picked.length;
}

// Dragging one of several selected cards carries the whole selection to the
// slot, in the order they were in. `slot` is a gap between cards, 0..length.
export function reorderSelectionTo(node, targets, slot) {
    const items = imagesOf(node);
    const picked = targets.map((index) => items[index]).filter(Boolean);
    if (!picked.length) return 0;
    const before = items.slice(0, slot).filter((item) => !picked.includes(item));
    const after = items.slice(slot).filter((item) => !picked.includes(item));
    const next = [...before, ...picked, ...after];
    if (next.every((item, index) => item === items[index])) return 0;
    node._msImages = next;
    remapSelection(node, picked.map((_, i) => before.length + i));
    return picked.length;
}
