import { api } from "../../scripts/api.js";

export const CROPPED_EPSILON = 0.0005;
// Mirrored by _MAX_IMAGES in multi_stitch.py; a backend test checks they agree.
export const MAX_IMAGES = 256;
// Longest side kept for a thumbnail. Cards are ~130 CSS px wide, so this stays
// crisp on a 2x display at 2x canvas zoom while bounding memory to about
// 1 MiB per image instead of a full-resolution canvas each.
export const THUMB_MAX_SIDE = 512;

// The thumbnail grid, shared so the canvas and the DOM rendering lay out the
// same list the same way. The node's minimum width gives three columns; a
// wider node fits more cards of about the same size rather than stretching
// three of them.
export const NODE_MIN_WIDTH = 420;
export const THUMB_TARGET_W = 130;
export const THUMB_GAP = 7;
export const THUMB_PADDING = 16;

export function columnsForWidth(width) {
    const usable = Math.max(NODE_MIN_WIDTH, Number(width) || NODE_MIN_WIDTH) - THUMB_PADDING;
    return Math.max(1, Math.floor((usable + THUMB_GAP) / (THUMB_TARGET_W + THUMB_GAP)));
}

export function defaultCrop() {
    return { x: 0, y: 0, w: 1, h: 1 };
}

// Mirrors the backend _normalize_crop, including its collapsed-crop fallback,
// so the node preview can never disagree with the rendered output.
export function normalizeCrop(crop) {
    const c = crop && typeof crop === "object" ? crop : defaultCrop();
    const number = (value, fallback) => {
        if (value == null || typeof value === "string" && !value.trim()) return fallback;
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    };
    const x = Math.min(Math.max(number(c.x, 0), 0), 1);
    const y = Math.min(Math.max(number(c.y, 0), 0), 1);
    const w = Math.min(Math.max(number(c.w, 1), 0), 1 - x);
    const h = Math.min(Math.max(number(c.h, 1), 0), 1 - y);
    if (w <= 0.000001 || h <= 0.000001) return defaultCrop();
    return { x, y, w, h };
}

// Mirrors the backend _grid_shape: down/up fill column-first, so once rows is
// fixed only ceil(count / rows) columns are actually used.
export function gridShape(count, gridColumns, direction) {
    const n = Math.max(1, Math.floor(Number(count) || 1));
    let cols = Math.max(1, Math.min(Math.floor(Number(gridColumns) || 1), n));
    const rows = Math.ceil(n / cols);
    if (direction === "down" || direction === "up") cols = Math.ceil(n / rows);
    return { rows, cols };
}

export const DIRECTIONS = ["right", "down", "left", "up"];
export const LAYOUT_MODES = ["strip", "grid"];
export const MATCH_REFERENCES = ["first", "largest", "smallest"];
// size_reference is an image number, 1 = the first; these names it briefly
// used are still understood.
export const LEGACY_SIZE_REFERENCES = ["first", "largest", "smallest"];
// Mirrors _SIZE_ASPECTS. "reference" keeps the image's own shape, which is what
// the outputs did before presets existed.
export const SIZE_ASPECTS = ["reference", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];

// Mirrors _aspect_ratio: the width/height a preset names, 0 to keep the
// image's own. Anything unknown — including the value a workflow saved before
// this existed — is "reference".
export function aspectRatio(sizeAspect) {
    if (typeof sizeAspect !== "string" || !SIZE_ASPECTS.includes(sizeAspect) || sizeAspect === "reference") return 0;
    const [w, h] = sizeAspect.split(":");
    return Number(w) / Number(h);
}
export const OUTPUT_LIMITS = ["none", "max_width", "max_height", "max_long_side"];

// Python's round() is half-to-even; Math.round is half-up. The backend sizes
// images with int(round(x)), so the preview must round the same way or a
// value like 2.5 would put the estimate one pixel off the real output.
export function roundHalfEven(value) {
    const floor = Math.floor(value);
    const diff = value - floor;
    if (diff > 0.5) return floor + 1;
    if (diff < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
}

function requireChoice(name, value, allowed) {
    if (!allowed.includes(value)) throw new RangeError(`${name} must be one of ${allowed.join(", ")}, got ${value}`);
    return value;
}

// Mirrors _prepared_strip_dims: sizes after match_image_size, in list order.
// Mirrors _reference_index: the image the others are matched to. "largest"
// and "smallest" go by the shared side in a strip (height when horizontal,
// width when vertical) and by area in a grid; the earlier image wins a tie.
export function referenceIndex(dims, layoutMode, direction, matchReference) {
    requireChoice("match_reference", matchReference, MATCH_REFERENCES);
    if (matchReference === "first" || dims.length <= 1) return 0;
    const keys = dims.map((d) => (layoutMode === "grid" ? d.w * d.h
        : (direction === "left" || direction === "right") ? d.h : d.w));
    let best = 0;
    for (let i = 1; i < keys.length; i++) {
        if (matchReference === "largest" ? keys[i] > keys[best] : keys[i] < keys[best]) best = i;
    }
    return best;
}

export function preparedStripDims(dims, direction, matchImageSize, matchReference = "first") {
    if (!matchImageSize || dims.length <= 1) return dims.map((d) => ({ w: d.w, h: d.h }));
    const reference = referenceIndex(dims, "strip", direction, matchReference);
    const ref = dims[reference];
    return dims.map(({ w, h }, index) => {
        if (index === reference) return { w, h };
        if (direction === "left" || direction === "right") {
            return { w: Math.max(1, roundHalfEven(w * (ref.h / h))), h: ref.h };
        }
        return { w: ref.w, h: Math.max(1, roundHalfEven(h * (ref.w / w))) };
    });
}

// Mirrors _size_reference_index: the image size_reference names, by its
// number from 1, clamped to the list (past the end: the last image; 0 or
// less: the first). The legacy names resolve too: first, or the largest /
// smallest by area, an earlier image winning a tie.
export function sizeReferenceIndex(dimensions, sizeReference) {
    if (!dimensions.length) throw new RangeError("at least one image is required");
    const name = typeof sizeReference === "string" ? sizeReference.trim().toLowerCase() : "";
    if (LEGACY_SIZE_REFERENCES.includes(name)) {
        if (name === "first") return 0;
        const areas = dimensions.map((d) => d.w * d.h);
        const target = name === "largest" ? Math.max(...areas) : Math.min(...areas);
        return areas.indexOf(target);
    }
    const number = Math.trunc(Number(sizeReference));
    if (!Number.isFinite(number)) throw new RangeError(`size_reference must be an image number (1 = first), got ${sizeReference}`);
    return Math.min(Math.max(1, number), dimensions.length) - 1;
}

// Mirrors _reference_size: the width/height outputs — one image's own size,
// rescaled to a megapixel target when one is set, each side snapped to the
// nearest multiple of the step (never below it). Half-even rounding, like
// Python's round().

export function referenceSize(dimensions, sizeReference, megapixels, divisibleBy, sizeAspect = "reference") {
    const index = sizeReferenceIndex(dimensions, sizeReference);
    let width = dimensions[index].w;
    let height = dimensions[index].h;
    // A preset replaces the shape and keeps the area, as the backend does.
    const ratio = aspectRatio(sizeAspect);
    if (ratio > 0) {
        const area = width * height;
        height = Math.sqrt(area / ratio);
        width = height * ratio;
    }
    const target = Number(megapixels) || 0;
    if (target > 0) {
        const scale = Math.sqrt(target * 1_000_000 / (width * height));
        width *= scale;
        height *= scale;
    }
    const step = Math.max(1, Math.trunc(Number(divisibleBy) || 1));
    return {
        w: Math.max(step, roundHalfEven(width / step) * step),
        h: Math.max(step, roundHalfEven(height / step) * step),
    };
}

// Mirrors _fit_size.
export function fitSize(w, h, cellW, cellH) {
    const scale = Math.min(cellH / h, cellW / w);
    return { w: Math.max(1, roundHalfEven(w * scale)), h: Math.max(1, roundHalfEven(h * scale)) };
}

// Mirrors _grid_position.
export function gridPosition(index, rows, cols, direction) {
    if (direction === "left") {
        return { row: Math.floor(index / cols), col: cols - 1 - (index % cols) };
    }
    if (direction === "down" || direction === "up") {
        const col = Math.floor(index / rows);
        let row = index % rows;
        if (direction === "up") row = rows - 1 - row;
        return { row, col };
    }
    return { row: Math.floor(index / cols), col: index % cols };
}

// Mirrors the backend _layout exactly: the canvas size and the rect each
// image occupies, in list order. The preview and the resolution estimate are
// drawn from this, and a parity test compares it with Python case by case.
export function layoutPlacements(dimensions, layoutMode, direction, matchImageSize, gridColumns, spacingWidth, cellWidth = 0, cellHeight = 0, matchReference = "first") {
    if (!dimensions.length) throw new RangeError("at least one image is required");
    requireChoice("direction", direction, DIRECTIONS);
    requireChoice("layout_mode", layoutMode, LAYOUT_MODES);
    requireChoice("match_reference", matchReference, MATCH_REFERENCES);
    const spacing = Math.max(0, Math.trunc(Number(spacingWidth) || 0));
    const dims = dimensions.map((d) => ({ w: Math.max(1, Math.trunc(d.w)), h: Math.max(1, Math.trunc(d.h)) }));

    if (layoutMode === "grid") {
        const { rows, cols } = gridShape(dims.length, gridColumns, direction);
        let cellW = Math.max(0, Math.trunc(Number(cellWidth) || 0));
        let cellH = Math.max(0, Math.trunc(Number(cellHeight) || 0));
        let placed;
        if (cellW > 0 && cellH > 0) {
            placed = dims.map((d) => fitSize(d.w, d.h, cellW, cellH));
        } else if (matchImageSize) {
            const ref = dims[referenceIndex(dims, "grid", direction, matchReference)];
            cellW = ref.w;
            cellH = ref.h;
            placed = dims.map((d) => fitSize(d.w, d.h, cellW, cellH));
        } else {
            cellW = Math.max(...dims.map((d) => d.w));
            cellH = Math.max(...dims.map((d) => d.h));
            placed = dims;
        }
        const placements = placed.map(({ w, h }, index) => {
            const { row, col } = gridPosition(index, rows, cols, direction);
            return {
                x: col * (cellW + spacing) + Math.floor((cellW - w) / 2),
                y: row * (cellH + spacing) + Math.floor((cellH - h) / 2),
                w,
                h,
            };
        });
        return {
            width: cols * cellW + spacing * (cols - 1),
            height: rows * cellH + spacing * (rows - 1),
            placements,
        };
    }

    const prepared = preparedStripDims(dims, direction, matchImageSize, matchReference);
    const order = prepared.map((_, i) => i);
    if (direction === "left" || direction === "up") order.reverse();
    const horizontal = direction === "left" || direction === "right";
    let width, height;
    if (horizontal) {
        height = Math.max(...prepared.map((d) => d.h));
        width = prepared.reduce((sum, d) => sum + d.w, 0) + spacing * (prepared.length - 1);
    } else {
        width = Math.max(...prepared.map((d) => d.w));
        height = prepared.reduce((sum, d) => sum + d.h, 0) + spacing * (prepared.length - 1);
    }
    const placements = new Array(prepared.length);
    let cursor = 0;
    for (const index of order) {
        const { w, h } = prepared[index];
        if (horizontal) {
            placements[index] = { x: cursor, y: Math.floor((height - h) / 2), w, h };
            cursor += w + spacing;
        } else {
            placements[index] = { x: Math.floor((width - w) / 2), y: cursor, w, h };
            cursor += h + spacing;
        }
    }
    return { width, height, placements };
}

// Grid column counts worth trying: every one that changes the shape. Beyond
// the image count the rows stop changing, so the search is bounded by it and
// by what the widget allows.
export const GRID_TARGET_ASPECTS = ["off", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
export const MAX_GRID_COLUMNS = 16;

// Mirrors _choose_grid_columns: the column count whose finished canvas comes
// closest to `target`, measured on a log scale so 2x too wide and 2x too tall
// count the same. A tie keeps the fewer columns, which is the first tried.
export function chooseGridColumns(dimensions, target, direction, matchImageSize, spacingWidth, cellWidth = 0, cellHeight = 0, matchReference = "first") {
    const ratio = aspectRatio(target);
    const count = dimensions.length;
    if (!(ratio > 0) || !count) return null;
    let best = null;
    let bestCost = Infinity;
    for (let cols = 1; cols <= Math.min(count, MAX_GRID_COLUMNS); cols++) {
        const { width, height } = layoutPlacements(dimensions, "grid", direction, matchImageSize, cols,
            spacingWidth, cellWidth, cellHeight, matchReference);
        if (!(width > 0) || !(height > 0)) continue;
        const cost = Math.abs(Math.log((width / height) / ratio));
        if (cost < bestCost - 1e-12) {
            bestCost = cost;
            best = cols;
        }
    }
    return best;
}

// Mirrors _limited_size: the final size after the output cap, never larger.
export function limitedSize(width, height, outputLimit, outputLimitPx) {
    requireChoice("output_limit", outputLimit, OUTPUT_LIMITS);
    if (outputLimit === "none") return { w: width, h: height };
    const limit = Math.max(1, Math.trunc(Number(outputLimitPx) || 1));
    const current = { max_width: width, max_height: height, max_long_side: Math.max(width, height) }[outputLimit];
    if (current <= limit) return { w: width, h: height };
    const scale = limit / current;
    return { w: Math.max(1, roundHalfEven(width * scale)), h: Math.max(1, roundHalfEven(height * scale)) };
}

export function normalizeTransform(item) {
    const value = Number(item?.rotation);
    const raw = Number.isFinite(value) ? value : 0;
    const rotation = ((roundHalfEven(raw / 90) * 90) % 360 + 360) % 360;
    return {
        rotation,
        flip_h: !!item?.flip_h,
        flip_v: !!item?.flip_v,
    };
}

export function cropPixelBox(width, height, crop) {
    const c = normalizeCrop(crop);
    const x = Math.max(0, Math.min(width - 1, roundHalfEven(c.x * width)));
    const y = Math.max(0, Math.min(height - 1, roundHalfEven(c.y * height)));
    const right = Math.max(x + 1, Math.min(width, roundHalfEven((c.x + c.w) * width)));
    const bottom = Math.max(y + 1, Math.min(height, roundHalfEven((c.y + c.h) * height)));
    return { x, y, w: right - x, h: bottom - y };
}

// What an image measures, and what a crop leaves of it. The second number
// comes out of cropPixelBox, so the size shown here is the size the server
// cuts — the UI never reports a resolution the run would not produce.
export function sizeText(width, height, crop) {
    const w = Math.max(1, Math.trunc(width) || 1);
    const h = Math.max(1, Math.trunc(height) || 1);
    const box = cropPixelBox(w, h, crop);
    return box.w === w && box.h === h ? `${w} × ${h}` : `${w} × ${h} → ${box.w} × ${box.h}`;
}

function rotateCrop(crop, rotation) {
    const { x, y, w, h } = crop;
    if (rotation === 90) return { x: 1 - y - h, y: x, w: h, h: w };
    if (rotation === 180) return { x: 1 - x - w, y: 1 - y - h, w, h };
    if (rotation === 270) return { x: y, y: 1 - x - w, w: h, h: w };
    return { x, y, w, h };
}

// A crop is stored relative to the *transformed* image. renderTransformedImage
// rotates clockwise and then flips, so mapping a crop between the source and a
// view of it follows that order forwards and reverses it backwards. This lets
// the editor carry a crop across a rotate/flip instead of discarding it.
export function cropSourceToView(crop, transform) {
    const t = normalizeTransform(transform);
    let out = rotateCrop(crop, t.rotation);
    if (t.flip_h) out = { ...out, x: 1 - out.x - out.w };
    if (t.flip_v) out = { ...out, y: 1 - out.y - out.h };
    return out;
}

export function cropViewToSource(crop, transform) {
    const t = normalizeTransform(transform);
    let out = { ...crop };
    if (t.flip_v) out = { ...out, y: 1 - out.y - out.h };
    if (t.flip_h) out = { ...out, x: 1 - out.x - out.w };
    return rotateCrop(out, (360 - t.rotation) % 360);
}

// Why the clipboard cannot be written: no API at all, or an API the browser
// only offers in a secure context. The two need different answers.
export function clipboardUnavailable() {
    const haveApi = typeof navigator !== "undefined" && !!navigator.clipboard?.write && typeof ClipboardItem !== "undefined";
    if (haveApi) return null;
    if (typeof globalThis.isSecureContext === "boolean" && !globalThis.isSecureContext) {
        return "Writing images to the clipboard needs a secure context: open ComfyUI over https:// or on localhost.";
    }
    return "This browser has no clipboard image API (navigator.clipboard.write with ClipboardItem). " +
        "Right-click the node and copy an original, or queue the workflow and save the result.";
}

// A canvas as a PNG blob, for the clipboard.
export function canvasPngBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("could not encode the image as PNG"))),
            "image/png",
        );
    });
}

// Writes one PNG to the clipboard. The pending promise goes in first: that
// keeps the click's user gesture alive while the blob is encoded, which Safari
// requires, and browsers that reject a pending promise get the resolved blob.
export async function writePngToClipboard(blob) {
    try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    } catch (_) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": await blob })]);
    }
}

// Mirrors the _MAX_BLUR_* limits in multi_stitch.py: what the editor is
// allowed to store is exactly what the server is willing to paint.
export const MAX_BLUR_STROKES = 200;
export const MAX_BLUR_POINTS = 20000;
export const MAX_BLUR_RADIUS = 0.5;
export const MAX_BLUR_STRENGTH = 0.25;

// Numbers only: Number(null) and Number("") are 0, which would quietly turn
// a broken coordinate into a real one, and the server drops it instead.
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

// The strokes an item carries, or null when there is nothing to paint.
// Coordinates are fractions of the *transformed* image, exactly like the crop,
// so a rotation carries them with the picture; radii are fractions of its
// longest side, which a quarter turn leaves alone.
export function normalizeBlur(blur) {
    if (!blur || typeof blur !== "object" || !Array.isArray(blur.strokes)) return null;
    const strength = finite(blur.strength);
    if (strength === null || strength <= 0) return null;

    let budget = MAX_BLUR_POINTS;
    const strokes = [];
    for (const raw of blur.strokes.slice(0, MAX_BLUR_STROKES)) {
        if (!raw || !Array.isArray(raw.pts)) continue;
        const radius = finite(raw.r);
        if (radius === null || radius <= 0) continue;
        const pts = [];
        for (const point of raw.pts.slice(0, budget)) {
            if (!Array.isArray(point) || point.length !== 2) continue;
            const x = finite(point[0]);
            const y = finite(point[1]);
            // A stroke drawn off the edge keeps going: only absurd values are cut.
            if (x === null || y === null) continue;
            pts.push([Math.min(Math.max(x, -0.5), 1.5), Math.min(Math.max(y, -0.5), 1.5)]);
        }
        budget -= pts.length;
        if (pts.length) strokes.push({ r: Math.min(radius, MAX_BLUR_RADIUS), pts });
        if (budget <= 0) break;
    }
    if (!strokes.length) return null;
    return { strength: Math.min(strength, MAX_BLUR_STRENGTH), strokes };
}

export function isBlurred(item) {
    return normalizeBlur(item?.blur) !== null;
}

// A point travels between the source and a view of it exactly as a crop does,
// so it goes through the same function as a rectangle with no size.
function mapPoints(blur, transform, map) {
    const spec = normalizeBlur(blur);
    if (!spec) return null;
    return {
        strength: spec.strength,
        strokes: spec.strokes.map(({ r, pts }) => ({
            r,
            pts: pts.map(([x, y]) => {
                const out = map({ x, y, w: 0, h: 0 }, transform);
                return [out.x, out.y];
            }),
        })),
    };
}

export function blurSourceToView(blur, transform) {
    return mapPoints(blur, transform, cropSourceToView);
}

export function blurViewToSource(blur, transform) {
    return mapPoints(blur, transform, cropViewToSource);
}

// Identifies the strokes for a cache key: two items with the same painting
// share a rendering, and one more dab makes a new one.
export function blurKey(blur) {
    const spec = normalizeBlur(blur);
    if (!spec) return "";
    return `${spec.strength}:${spec.strokes.map(({ r, pts }) => `${r}/${pts.length}/${pts[0]}/${pts.at(-1)}`).join(";")}`;
}

export function isCropped(crop) {
    const c = normalizeCrop(crop);
    return Math.abs(c.x) > CROPPED_EPSILON || Math.abs(c.y) > CROPPED_EPSILON ||
        Math.abs(c.w - 1) > CROPPED_EPSILON || Math.abs(c.h - 1) > CROPPED_EPSILON;
}

export function isTransformed(item) {
    const t = normalizeTransform(item);
    return t.rotation !== 0 || t.flip_h || t.flip_v;
}

// Returns null when the value cannot be read as an image list, so callers can
// tell "genuinely empty" from "unreadable" and avoid overwriting the original.
export function safeJsonParse(value) {
    try {
        const data = JSON.parse(value || "[]");
        if (Array.isArray(data)) return data;
        console.warn("[Multi Stitch Images] image list is not an array, ignoring:", value);
        return null;
    } catch (error) {
        console.warn("[Multi Stitch Images] could not parse the image list:", error, value);
        return null;
    }
}

// Keys a modal over the graph must not let through. The canvas keeps focus
// after the click that opened the overlay, and ComfyUI listens on the
// document: Delete would delete the node under the modal, Space arms
// LiteGraph's pan and Ctrl+Z reloads the whole graph (which recreates every
// node). Every one of these is swallowed while an overlay is open, whether
// that overlay acts on it or not.
export const MODAL_KEYS = new Set([
    "Escape", "Enter", " ", "Spacebar", "Delete", "Backspace",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown",
]);

export function isModalKey(event) {
    if (!event) return false;
    if ((event.ctrlKey || event.metaKey) && /^[zy]$/i.test(String(event.key))) return true;
    return MODAL_KEYS.has(event.key);
}

// A field the user may be typing in: it keeps the key, but the canvas
// underneath still must not see it.
export function isTextEntry(target) {
    const tag = String(target?.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable === true;
}

export function swallowKey(event) {
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
}

export function getWidget(node, name) {
    return node.widgets?.find((widget) => widget.name === name);
}

// ComfyUI has two widget render paths now:
// - legacy LiteGraph canvas
// - Vue Nodes / Node 2.0
//
// Vue Nodes uses options.hidden; the legacy canvas keeps drawing regardless, so
// draw()/computeSize() must be swapped too. Conditionally shown widgets need
// that swap undone, so record whether the originals were own properties and
// restore them exactly. Every caller goes through here — a second, partial
// implementation is what left grid_columns drawing over the thumbnails.
export function setWidgetHidden(widget, hidden) {
    if (!widget) return;
    widget.options ||= {};
    widget.options.hidden = hidden;
    try { widget.hidden = hidden; } catch (_) {}
    widget._msHidden = hidden;

    if (hidden) {
        widget._msPatched ||= {
            computeSize: Object.prototype.hasOwnProperty.call(widget, "computeSize")
                ? widget.computeSize : null,
            draw: Object.prototype.hasOwnProperty.call(widget, "draw") ? widget.draw : null,
        };
        widget.computeSize = () => [0, -4];
        widget.draw = () => {};
    } else if (widget._msPatched) {
        const original = widget._msPatched;
        if (original.computeSize) widget.computeSize = original.computeSize;
        else delete widget.computeSize;
        if (original.draw) widget.draw = original.draw;
        else delete widget.draw;
        widget._msPatched = null;
    }
    widget.triggerDraw?.();
}

export function hideWidget(widget) {
    setWidgetHidden(widget, true);
}

export function syncImages(node) {
    const serialized = JSON.stringify(node._msImages || []);
    const widget = getWidget(node, "images_json");
    if (widget) widget.value = serialized;
    node.properties ||= {};
    node.properties.multi_stitch_images = serialized;
    node.graph?.setDirtyCanvas(true, true);
}

// Edit history. `_msCommitted` is the last written list; each commit that
// changes it pushes the previous list onto `past`. Kept in memory only: a
// reloaded workflow starts with an empty history.
export const HISTORY_LIMIT = 50;

export function historyOf(node) {
    node._msHistory ||= { past: [], future: [] };
    return node._msHistory;
}

export function resetHistory(node) {
    const history = historyOf(node);
    history.past.length = 0;
    history.future.length = 0;
    node._msCommitted = JSON.stringify(node._msImages || []);
}

// Writes the list to the widget/properties and records the change.
export function commitImages(node) {
    const now = JSON.stringify(node._msImages || []);
    if (node._msCommitted === undefined) {
        node._msCommitted = now;
    } else if (now !== node._msCommitted) {
        const history = historyOf(node);
        history.past.push(node._msCommitted);
        if (history.past.length > HISTORY_LIMIT) history.past.shift();
        history.future.length = 0;
        node._msCommitted = now;
    }
    syncImages(node);
}

function restoreSnapshot(node, snapshot) {
    node._msImages = JSON.parse(snapshot);
    node._msCommitted = snapshot;
    node._msTransformedCache?.clear();
    syncImages(node);
}

export function undoImages(node) {
    const history = historyOf(node);
    if (!history.past.length) return false;
    history.future.push(node._msCommitted ?? JSON.stringify(node._msImages || []));
    restoreSnapshot(node, history.past.pop());
    return true;
}

export function redoImages(node) {
    const history = historyOf(node);
    if (!history.future.length) return false;
    history.past.push(node._msCommitted ?? JSON.stringify(node._msImages || []));
    restoreSnapshot(node, history.future.pop());
    return true;
}

export function imageUrl(item) {
    const params = new URLSearchParams();
    params.set("filename", item.filename);
    params.set("type", item.type || "input");
    if (item.subfolder) params.set("subfolder", item.subfolder);
    return api.apiURL(`/view?${params.toString()}`);
}

// The cache key of one entry: the file it points at, so two entries on the
// same file share one decode and removing one leaves the other's pixels alone.
export function thumbCacheKey(item) {
    return `${item?.type || "input"}:${item?.subfolder || ""}/${item?.filename}`;
}

const thumbKey = thumbCacheKey;

// Drops the cached pixels of one entry — used when it is removed or relinked,
// so the rest of the list is not re-downloaded and re-decoded. `remaining` is
// the list as it will be: another entry on the same file keeps the cache.
export function forgetThumb(node, item, remaining = node?._msImages || []) {
    const key = thumbCacheKey(item);
    if (remaining.some((other) => other !== item && thumbCacheKey(other) === key)) return false;
    node._msThumbCache?.get(key)?.cancel?.();
    node._msThumbCache?.delete(key);
    node._msTransformedCache?.delete(key);
    return true;
}

// Loads one entry again from scratch. A load that timed out gets exactly one
// retry; after that the card offers relinking instead.
export function retryThumb(node, item) {
    const key = thumbCacheKey(item);
    const previous = node._msThumbCache?.get(key);
    node._msThumbCache?.delete(key);
    node._msTransformedCache?.delete(key);
    const state = loadThumb(node, item);
    state.retried = !!previous;
    return state;
}

function smoothContext(canvas) {
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    return ctx;
}

// Draws a region of `source` into `ctx` at (dx, dy, dw, dh) at the best
// quality a canvas offers: smoothing set to "high", and a reduction below
// one half done by halving through intermediate canvases first, since a
// single drawImage() from 4000px down to 500px aliases visibly.
export function drawImageScaled(ctx, source, sx, sy, sw, sh, dx, dy, dw, dh) {
    let current = source;
    let cx = sx, cy = sy, cw = sw, ch = sh;
    while (cw / 2 >= dw && ch / 2 >= dh && cw >= 2 && ch >= 2) {
        const step = document.createElement("canvas");
        step.width = Math.max(1, Math.round(cw / 2));
        step.height = Math.max(1, Math.round(ch / 2));
        smoothContext(step).drawImage(current, cx, cy, cw, ch, 0, 0, step.width, step.height);
        current = step;
        cx = 0;
        cy = 0;
        cw = step.width;
        ch = step.height;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(current, cx, cy, cw, ch, dx, dy, dw, dh);
}

// Shrink to at most maxSide on the long edge, through the same stepwise
// reduction.
function scaledCanvas(source, width, height, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(width * scale));
    out.height = Math.max(1, Math.round(height * scale));
    drawImageScaled(smoothContext(out), source, 0, 0, width, height, 0, 0, out.width, out.height);
    return out;
}

// Avoid starting hundreds of full-resolution browser decodes simultaneously.
// Only two files may be loading/shrinking at once across all stitch nodes.
const thumbnailQueue = [];
let thumbnailLoads = 0;
function pumpThumbnails() {
    while (thumbnailLoads < 2 && thumbnailQueue.length) {
        const task = thumbnailQueue.shift();
        thumbnailLoads++;
        task(() => { thumbnailLoads--; pumpThumbnails(); });
    }
}

// Formats Pillow reads but no browser decodes. The upload succeeded and the
// backend will stitch the file; only the preview cannot exist here, so the
// card must not claim the image is broken.
const SERVER_ONLY_FORMATS = /\.(tiff?|psd|psb|heic|heif|jp2|jpf|jpx|exr|hdr|dng|cr2|cr3|nef|arw|raf|orf|rw2|srw|pef|tga|pcx|ppm|pgm|pbm|pnm|sgi|dds|xcf|jfif2)$/i;

// 30 s is the budget for one load; a test shortens it.
export const THUMB_LOAD_TIMEOUT_MS = 30000;
let thumbLoadTimeoutMs = THUMB_LOAD_TIMEOUT_MS;
export function setThumbLoadTimeout(ms) {
    thumbLoadTimeoutMs = Math.max(1, Number(ms) || THUMB_LOAD_TIMEOUT_MS);
}

// Why a thumbnail has no pixels, in the words the card and the DOM view show.
// A timeout is worth retrying; a format the browser cannot decode is not a
// broken file; anything else is most likely a file that moved away.
export function thumbFailureMessage(state) {
    if (state?.reason === "timeout") {
        return state.retried ? "Timed out twice · click to relink" : "Timed out · click to retry";
    }
    if (state?.reason === "format") return "Cannot preview here · stitches on the server · click to relink";
    return "Load failed · click to relink";
}

// Loads a source once and keeps only a bounded copy of it. `width`/`height`
// are the true source size; `image` is the thumbnail-sized canvas. The full
// decode is released as soon as the copy exists, so a node full of large
// images does not pin every original in browser memory.
export function loadThumb(node, item) {
    node._msThumbCache ||= new Map();
    const key = thumbKey(item);
    if (node._msThumbCache.has(key)) return node._msThumbCache.get(key);

    const state = { image: null, width: 0, height: 0, ready: false, failed: false, reason: null, message: null, retried: false };
    node._msThumbCache.set(key, state);
    thumbnailQueue.push((release) => {
        if (node._msDisposed || node._msThumbCache.get(key) !== state) { release(); return; }
        try {
            startThumbLoad(node, key, state, item, release);
        } catch (_) {
            failThumb(state, "error");
            release();
        }
    });
    pumpThumbnails();
    return state;
}

function failThumb(state, reason) {
    state.failed = true;
    state.reason = reason;
    state.message = thumbFailureMessage(state);
}

function startThumbLoad(node, key, state, item, release) {
    {
        const image = new Image();
        let done = false;
        let timeout;
        const finish = (reason = null) => {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            image.onload = image.onerror = null;
            state.cancel = null;
            if (reason) failThumb(state, reason);
            // Drop the original decode; the cache keeps only scaled pixels.
            image.src = "";
            node.graph?.setDirtyCanvas(true, false);
            release();
        };
        state.cancel = () => finish("cancelled");
        image.onload = () => {
            try {
                if (node._msDisposed || node._msThumbCache.get(key) !== state) return;
                state.width = image.naturalWidth || image.width || 1;
                state.height = image.naturalHeight || image.height || 1;
                state.image = scaledCanvas(image, state.width, state.height, THUMB_MAX_SIDE);
                state.ready = true;
            } catch (_) { failThumb(state, "error"); }
            finally { finish(); }
        };
        // The browser refuses a format it cannot decode exactly as it reports a
        // missing file, so the file name decides which of the two it is.
        image.onerror = () => finish(SERVER_ONLY_FORMATS.test(item?.filename || "") ? "format" : "error");
        timeout = setTimeout(() => finish("timeout"), thumbLoadTimeoutMs);
        image.src = imageUrl(item);
    }
}

export function transformedDimensions(width, height, item) {
    const { rotation } = normalizeTransform(item);
    return rotation === 90 || rotation === 270
        ? { width: height, height: width }
        : { width, height };
}

// The two working surfaces paintBlur needs, kept and reused: a brush stroke
// repaints on every pointer move, and allocating a pair of full-size canvases
// per frame is what makes a painting tool feel heavy. Never nested, so one
// pair is enough.
const scratch = {};
function scratchCanvas(name, width, height) {
    const canvas = scratch[name] ||= document.createElement("canvas");
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const ctx = canvas.getContext("2d");
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    } else {
        ctx.clearRect(0, 0, w, h);
    }
    // Resizing does not reset these, and a reused surface must not inherit the
    // filter and the compositing the last pass left behind.
    ctx.filter = "none";
    ctx.globalCompositeOperation = "source-over";
    return canvas;
}

// Paints the blurred strokes of `blur` over whatever `ctx` already shows,
// reading its pixels from `source`.
//
// `place` maps the transformed image onto the destination: an image pixel
// lands at ((x - offsetX) * scale, (y - offsetY) * scale), and `width`/`height`
// are the whole transformed image, which is what the coordinates are fractions
// of. Only the destination rectangle is touched, so the editor can call this
// for the part of a zoomed image it happens to be showing.
export function paintBlur(ctx, source, blur, place) {
    const spec = normalizeBlur(blur);
    if (!spec) return;
    const { width, height, scale, offsetX = 0, offsetY = 0, destW, destH } = place;
    const sigma = Math.max(0.5, spec.strength * Math.max(width, height)) * scale;
    const at = (x, y) => [(x * width - offsetX) * scale, (y * height - offsetY) * scale];

    // The strokes, white on nothing, softened by a fraction of the blur: a
    // hard edge makes the blur look pasted on. Mirrors _apply_blur's feather.
    const mask = scratchCanvas("mask", destW, destH);
    const maskCtx = mask.getContext("2d");
    maskCtx.filter = `blur(${Math.min(8, sigma * 0.3)}px)`;
    maskCtx.strokeStyle = maskCtx.fillStyle = "#fff";
    maskCtx.lineCap = maskCtx.lineJoin = "round";
    for (const { r, pts } of spec.strokes) {
        const radius = Math.max(0.5, r * Math.max(width, height)) * scale;
        maskCtx.lineWidth = radius * 2;
        maskCtx.beginPath();
        for (const [x, y] of pts) {
            const [px, py] = at(x, y);
            maskCtx.lineTo(px, py);
        }
        if (pts.length > 1) maskCtx.stroke();
        // The dot a single tap leaves, and round ends on every stroke.
        for (const [x, y] of pts) {
            const [px, py] = at(x, y);
            maskCtx.beginPath();
            maskCtx.arc(px, py, radius, 0, Math.PI * 2);
            maskCtx.fill();
        }
    }

    const layer = scratchCanvas("layer", destW, destH);
    const layerCtx = layer.getContext("2d");
    layerCtx.filter = `blur(${sigma}px)`;
    layerCtx.drawImage(
        source,
        offsetX, offsetY, destW / scale, destH / scale,
        0, 0, layer.width, layer.height,
    );
    layerCtx.filter = "none";
    layerCtx.globalCompositeOperation = "destination-in";
    layerCtx.drawImage(mask, 0, 0);
    ctx.drawImage(layer, 0, 0);
}

// maxSide > 0 bounds the result's long edge; 0 renders at the source's size,
// which the crop editor needs for pixel-accurate handles.
export function renderTransformedImage(source, item, maxSide = 0) {
    const sw = source.naturalWidth || source.videoWidth || source.width;
    const sh = source.naturalHeight || source.videoHeight || source.height;
    const { rotation, flip_h, flip_v } = normalizeTransform(item);
    const dims = transformedDimensions(sw, sh, item);
    const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(dims.width, dims.height)) : 1;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(dims.width * scale));
    canvas.height = Math.max(1, Math.round(dims.height * scale));
    const ctx = canvas.getContext("2d");

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(flip_h ? -1 : 1, flip_v ? -1 : 1);
    ctx.rotate(rotation * Math.PI / 180);
    ctx.drawImage(source, -sw * scale / 2, -sh * scale / 2, sw * scale, sh * scale);
    ctx.restore();

    // Only when the caller passed a whole item: the crop editor hands in a
    // transform on its own, because it paints the strokes live over a clean
    // picture instead of baking them into the one it edits.
    if (item?.blur) {
        paintBlur(ctx, canvas, item.blur, {
            width: dims.width, height: dims.height, scale,
            destW: canvas.width, destH: canvas.height,
        });
    }
    return canvas;
}

// One entry per file holding only the current transform, so cycling through
// rotations does not accumulate a canvas per angle. `width`/`height` are the
// true transformed size the resolution estimate needs; `image` is thumbnail
// sized with the blur strokes painted in, and an image with neither a
// transform nor a stroke reuses the base canvas outright.
export function loadTransformedThumb(node, item) {
    const raw = loadThumb(node, item);
    if (!raw.ready || raw.failed) return raw;

    node._msTransformedCache ||= new Map();
    const t = normalizeTransform(item);
    const transformKey = `r${t.rotation}:h${t.flip_h ? 1 : 0}:v${t.flip_v ? 1 : 0}:b${blurKey(item?.blur)}`;
    const key = thumbKey(item);
    const cached = node._msTransformedCache.get(key);
    if (cached && cached.transformKey === transformKey) return cached;

    const dims = transformedDimensions(raw.width, raw.height, t);
    const painted = { ...t, blur: item?.blur };
    const identity = t.rotation === 0 && !t.flip_h && !t.flip_v && !isBlurred(item);
    const state = {
        image: identity ? raw.image : renderTransformedImage(raw.image, painted, THUMB_MAX_SIDE),
        width: dims.width,
        height: dims.height,
        transformKey,
        ready: true,
        failed: false,
    };
    node._msTransformedCache.set(key, state);
    return state;
}

// The uploaded file keeps the name it came with, plus a unique tail: a frame
// captured as clip_12s345.png is recognisable in the input folder instead of
// being one more multi_stitch_<timestamp> among hundreds.
export function uniqueUploadName(file) {
    const raw = String(file?.name || "image.png");
    const rawExt = raw.split(".").pop().toLowerCase();
    const ext = /^[a-z0-9]{2,5}$/.test(rawExt) ? rawExt : "png";
    const stem = raw.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_").replace(/^[._]+/, "").slice(0, 40);
    const unique = `multi_stitch_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    return `${stem ? `${stem}_` : ""}${unique}.${ext}`;
}

// Uploads through ComfyUI's own endpoint. `target` picks the folder: images
// go to input/multi_stitch (the default); a video for frame capture goes to
// the temp folder, which ComfyUI empties on start-up.
export async function uploadFile(file, signal, target = {}) {
    const uploadName = uniqueUploadName(file);
    const subfolder = target.subfolder || "multi_stitch";
    const type = target.type || "input";
    const body = new FormData();
    body.append("image", file, uploadName);
    body.append("subfolder", subfolder);
    body.append("type", type);

    const response = await api.fetchApi("/upload/image", { method: "POST", body, signal });
    if (!response.ok) {
        const limit = response.status === 413
            ? " — larger than ComfyUI's upload limit (start ComfyUI with --max-upload-size to raise it)"
            : "";
        throw new Error(`Upload failed: ${response.status} ${response.statusText}${limit}`);
    }
    const data = await response.json();
    return {
        filename: data.name || uploadName,
        subfolder: data.subfolder || subfolder,
        type: data.type || type,
        crop: defaultCrop(),
        rotation: 0,
        flip_h: false,
        flip_v: false,
    };
}
