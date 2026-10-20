import {
    canvasPngBlob,
    clipboardUnavailable,
    CROPPED_EPSILON,
    cropPixelBox,
    cropSourceToView,
    cropViewToSource,
    imageUrl,
    isModalKey,
    isTextEntry,
    blurSourceToView,
    MAX_BLUR_STROKES,
    MAX_PAINT_STROKES,
    blurViewToSource,
    normalizeBlur,
    normalizeCrop,
    normalizePaint,
    normalizeTransform,
    paintBlur,
    paintSourceToView,
    paintStrokes,
    paintViewToSource,
    renderTransformedImage,
    sizeText,
    swallowKey,
    writePngToClipboard,
    commitImages,
} from "./shared.js";

let styleInstalled = false;

function installStyles() {
    if (styleInstalled) return;
    styleInstalled = true;

    const style = document.createElement("style");
    style.textContent = `
.ms-crop-overlay{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.ms-crop-panel{width:min(1140px,96vw);max-height:94vh;background:#202124;border:1px solid #555;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden;color:#eee}
.ms-crop-head{display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #3d3d3d;font-weight:650}
.ms-crop-stage{min-height:260px;display:flex;align-items:center;justify-content:center;padding:16px;background:#111;overflow:auto}
.ms-crop-canvas{max-width:100%;max-height:66vh;box-shadow:0 0 0 1px #333;touch-action:none;cursor:crosshair}
.ms-crop-controls{display:flex;flex-wrap:wrap;gap:9px;align-items:center;padding:12px 16px;border-top:1px solid #3d3d3d}
.ms-crop-controls label{display:flex;gap:8px;align-items:center;color:#cfcfcf;font-size:13px}
.ms-crop-controls select,.ms-crop-controls button{background:#303134;color:#eee;border:1px solid #5f6368;border-radius:7px;padding:7px 11px;font-size:13px}
.ms-crop-controls button{cursor:pointer}.ms-crop-controls button:hover{background:#3c4043}.ms-crop-controls .primary{background:#1a73e8;border-color:#1a73e8}
.ms-crop-controls .active{border-color:#8ab4f8;background:#35435d}
.ms-crop-zoom{display:flex;align-items:center;gap:5px}
.ms-crop-zoom button{padding:6px 10px;min-width:32px}
.ms-crop-zoom .zoom-level{font-size:12px;color:#cfcfcf;min-width:48px;text-align:center;font-variant-numeric:tabular-nums}
.ms-crop-spacer{flex:1}.ms-crop-hint{font-size:12px;color:#aaa}.ms-transform-state{font-size:12px;color:#9aa0a6;min-width:130px}
.ms-crop-hint.said{color:#8ab4f8}
.ms-crop-tools{display:flex;align-items:center;gap:5px}
.ms-crop-tools button{padding:7px 12px}
.ms-crop-controls .step-prev,.ms-crop-controls .step-next{padding:7px 13px;font-size:15px;line-height:1}
.ms-crop-controls button:disabled{opacity:.4;cursor:default}
/* The rule below sets display on an element the editor hides with [hidden],
   and an author rule outranks the browser's own [hidden] one whatever its
   specificity, so say it here. */
.ms-crop-brush,.ms-crop-brush .for-paint{display:flex;align-items:center;gap:8px;color:#cfcfcf;font-size:12px}
.ms-crop-brush[hidden],.ms-crop-brush [hidden]{display:none}
.ms-crop-brush input[type=range]{width:96px;accent-color:#8ab4f8}
.ms-crop-brush .value{min-width:42px;text-align:right;font-variant-numeric:tabular-nums}
.ms-swatches{display:flex;align-items:center;gap:5px}
.ms-crop-controls .swatch{width:22px;height:22px;min-width:22px;padding:0;border-radius:50%;border:2px solid #5f6368}
.ms-crop-controls .swatch.active{border-color:#8ab4f8;box-shadow:0 0 0 2px #35435d}
.ms-crop-brush input[type=color]{width:30px;height:24px;padding:0;border:1px solid #5f6368;border-radius:6px;background:#303134;cursor:pointer}
.ms-crop-menu{position:fixed;z-index:100001;background:#2b2b2b;border:1px solid #4a4a4a;border-radius:6px;padding:3px;display:flex;flex-direction:column;min-width:190px;box-shadow:0 6px 20px rgba(0,0,0,.55);font-size:13px}
.ms-crop-menu button{background:transparent;border:0;color:#e6e6e6;text-align:left;padding:6px 10px;border-radius:4px;cursor:pointer;font:inherit}
.ms-crop-menu button:hover{background:#3d5a80}
`;
    document.head.appendChild(style);
}

function ratioValue(name, image) {
    if (name === "original") return image.width / image.height;
    return {
        "1:1": 1,
        "4:3": 4 / 3,
        "3:2": 3 / 2,
        "16:9": 16 / 9,
        "9:16": 9 / 16,
    }[name] || null;
}

function fitRatio(rect, ratio, imageW, imageH) {
    if (!ratio) return rect;

    let w = rect.w;
    let h = w / ratio;
    if (h > rect.h) {
        h = rect.h;
        w = h * ratio;
    }

    return {
        x: Math.max(0, Math.min(imageW - w, rect.x + (rect.w - w) / 2)),
        y: Math.max(0, Math.min(imageH - h, rect.y + (rect.h - h) / 2)),
        w,
        h,
    };
}

function cursorForMode(mode) {
    return {
        nw: "nwse-resize",
        se: "nwse-resize",
        ne: "nesw-resize",
        sw: "nesw-resize",
        n: "ns-resize",
        s: "ns-resize",
        e: "ew-resize",
        w: "ew-resize",
        move: "move",
        new: "crosshair",
    }[mode] || "crosshair";
}

// The colours on offer for paint: three to cover with, three to mark with. The
// colour input next to them takes any other.
const SWATCHES = [
    ["#808080", "Grey"], ["#ffffff", "White"], ["#000000", "Black"],
    ["#ff0000", "Red"], ["#00cc44", "Green"], ["#ffd400", "Yellow"],
];

// The editor's own copy of an item's paint strokes, so drawing one more never
// reaches into the item until Apply.
function copyPaint(paint) {
    return (normalizePaint(paint)?.strokes || []).map((stroke) => ({ ...stroke, pts: [...stroke.pts] }));
}

// Decodes one of the node's images, or throws in the editor's own voice.
function loadSource(item) {
    const source = new Image();
    source.crossOrigin = "anonymous";
    source.src = imageUrl(item);
    return new Promise((resolve, reject) => {
        source.onload = () => resolve(source);
        source.onerror = () => reject(new Error("Could not load image for cropping."));
    });
}

export async function openCropEditor(node, index) {
    let item = node._msImages[index];
    if (!item) return;

    installStyles();

    let source = await loadSource(item);

    const overlay = document.createElement("div");
    overlay.className = "ms-crop-overlay";
    // Focusable, and focused at the end, so the keys go to the editor instead
    // of the canvas that was clicked to open it.
    overlay.tabIndex = -1;
    overlay.innerHTML = `
      <div class="ms-crop-panel" role="dialog" aria-modal="true">
        <div class="ms-crop-head">
          <span class="ms-crop-title">Edit image ${index + 1}</span>
          <span class="dimensions" style="font-size:12px;color:#aaa"></span>
        </div>
        <div class="ms-crop-stage"><canvas class="ms-crop-canvas"></canvas></div>
        <div class="ms-crop-controls">
          <button class="rotate-left" title="Rotate 90° left">↶ 90°</button>
          <button class="rotate-right" title="Rotate 90° right">↷ 90°</button>
          <button class="flip-h">Flip H</button>
          <button class="flip-v">Flip V</button>
          <span class="ms-transform-state"></span>
          <label>Aspect
            <select class="ratio">
              <option value="free">Free</option>
              <option value="original">Original</option>
              <option>1:1</option>
              <option>4:3</option>
              <option>3:2</option>
              <option>16:9</option>
              <option>9:16</option>
            </select>
          </label>
          <span class="ms-crop-tools">
            <button class="tool-crop active" title="Crop, rotate and flip">✂ Crop</button>
            <button class="tool-blur" title="Paint a blur over part of the picture">◍ Blur</button>
            <button class="tool-paint" title="Paint a colour over part of the picture: opaque to cover it, faint to mark it">✎ Paint</button>
          </span>
          <span class="ms-crop-brush" hidden>
            <label>Brush <input type="range" class="brush-size" min="2" max="100" step="1"><span class="value size-value"></span></label>
            <label class="for-blur">Blur <input type="range" class="brush-strength" min="1" max="100" step="1"><span class="value strength-value"></span></label>
            <span class="for-paint" hidden>
              <button class="paint-cover" title="Opaque grey: hide what is there, for a model to fill">■ Cover</button>
              <button class="paint-mark" title="Faint red: point at what an edit should change">○ Mark</button>
              <label>Opacity <input type="range" class="paint-opacity" min="5" max="100" step="5"><span class="value opacity-value"></span></label>
              <span class="ms-swatches"></span>
              <input type="color" class="paint-color" title="Any other colour">
            </span>
            <button class="blur-undo" title="Undo the last stroke (Ctrl+Z)">↶ Stroke</button>
            <button class="blur-clear" title="Remove every stroke">Clear blur</button>
          </span>
          <span class="ms-crop-zoom">
            <button class="zoom-out" title="Zoom out">−</button>
            <span class="zoom-level">100%</span>
            <button class="zoom-in" title="Zoom in">+</button>
            <button class="zoom-fit" title="Show the whole image">Fit</button>
          </span>
          <button class="reset-crop">Reset crop</button>
          <button class="reset-all">Reset all</button>
          <span class="ms-crop-hint">Drag bars/corners • inside: move • outside: new crop • wheel: zoom • space or middle drag: pan</span>
          <span class="ms-crop-spacer"></span>
          <button class="step-prev" title="Keep this edit and go to the previous image (←)">‹</button>
          <button class="step-next" title="Keep this edit and go to the next image (→)">›</button>
          <button class="cancel">Cancel</button>
          <button class="primary apply">Apply</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const canvas = overlay.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    const ratioSelect = overlay.querySelector(".ratio");
    const zoomLevel = overlay.querySelector(".zoom-level");
    const dimensions = overlay.querySelector(".dimensions");
    const transformState = overlay.querySelector(".ms-transform-state");
    const hint = overlay.querySelector(".ms-crop-hint");
    const title = overlay.querySelector(".ms-crop-title");
    const prevButton = overlay.querySelector(".step-prev");
    const nextButton = overlay.querySelector(".step-next");
    const brushBar = overlay.querySelector(".ms-crop-brush");
    const cropButton = overlay.querySelector(".tool-crop");
    const blurButton = overlay.querySelector(".tool-blur");
    const paintButton = overlay.querySelector(".tool-paint");
    const sizeSlider = overlay.querySelector(".brush-size");
    const strengthSlider = overlay.querySelector(".brush-strength");
    const sizeValue = overlay.querySelector(".size-value");
    const strengthValue = overlay.querySelector(".strength-value");
    const forBlur = overlay.querySelector(".for-blur");
    const forPaint = overlay.querySelector(".for-paint");
    const opacitySlider = overlay.querySelector(".paint-opacity");
    const opacityValue = overlay.querySelector(".opacity-value");
    const colourInput = overlay.querySelector(".paint-color");
    const swatchBar = overlay.querySelector(".ms-swatches");
    const clearButton = overlay.querySelector(".blur-clear");
    const CROP_HINT = hint.textContent;
    const BLUR_HINT = "Drag to paint a blur • Ctrl+Z takes a stroke back • the crop and the rotation still apply";
    const PAINT_HINT = "Drag to paint • opaque covers, faint marks • Ctrl+Z takes a stroke back";
    let hintText = CROP_HINT;
    // The row wraps around this text, so a short message in its place would
    // move Cancel and Apply. Freeze the box at the width the hint already has.
    hint.style.minWidth = `${Math.round(hint.getBoundingClientRect?.().width || 0)}px`;
    const flipHButton = overlay.querySelector(".flip-h");
    const flipVButton = overlay.querySelector(".flip-v");

    const maxW = Math.min(1000, innerWidth * 0.82);
    const maxH = Math.min(660, innerHeight * 0.66);

    let transform = normalizeTransform(item);
    let working = renderTransformedImage(source, transform);
    // Guards a load in flight: two quick presses of Next must not leave the
    // slower one to finish last and show the wrong picture.
    let loading = 0;
    let rect;
    let scale = 1;
    const MAX_ZOOM = 16;
    let drag = null;
    // The part of the image the canvas shows, in image pixels. Zooming shrinks
    // it around a point; panning slides it. Everything else works in image
    // pixels and goes through this, so the crop maths never learns about zoom.
    let view = null;
    // A pan in progress: where the pointer went down, and the view it started
    // from. `spaceHeld` is the other way into one.
    let pan = null;
    let spaceHeld = false;
    // The blur brush. Strokes are fractions of the transformed image, as the
    // crop is, and radii fractions of its longest side, which a quarter turn
    // leaves alone. `painting` is the stroke being drawn, of the kind in
    // `paintingKind`. The paint brush is the same thing with a colour and an
    // opacity on every stroke, in a list of its own: `strokes` is the blur's.
    let tool = "crop";
    let strokes = (normalizeBlur(item.blur)?.strokes || []).map((stroke) => ({ r: stroke.r, pts: [...stroke.pts] }));
    let paintList = copyPaint(item.paint);
    // The colour and opacity the next paint stroke gets. They belong to the
    // editor, not to the picture, so they stay put as it moves to the next
    // one — covering a face on every photo is one colour, picked once.
    let paintColour = normalizePaint(item.paint)?.strokes.at(-1).c ?? SWATCHES[0][0];
    let paintOpacity = normalizePaint(item.paint)?.strokes.at(-1).a ?? 1;
    let lastBrush = "blur";
    let painting = null;
    let paintingKind = "blur";
    let brushAt = null;
    let brushRadius = 0;
    let blurStrength = 0;
    let handleRadius = 10;
    let edgeHit = 12;
    let minSize = 4;

    function setCanvasSize() {
        scale = Math.min(1, maxW / working.width, maxH / working.height);
        canvas.width = Math.max(1, Math.round(working.width * scale));
        canvas.height = Math.max(1, Math.round(working.height * scale));
        view = { x: 0, y: 0, w: working.width, h: working.height };
        applyViewMetrics();
    }

    // Grab areas are a constant number of screen pixels, so they are expressed
    // in image pixels through whatever the view is showing. Zooming in
    // therefore also buys a finer minimum crop.
    function applyViewMetrics() {
        const viewScale = canvas.width / view.w;
        // The floor is only there so nothing can reach zero; at 16x, the
        // deepest zoom, 14 canvas pixels is still most of an image pixel.
        handleRadius = Math.max(1, 14 / viewScale);
        edgeHit = Math.max(1, 12 / viewScale);
        minSize = Math.max(1, 8 / viewScale);
    }

    // Keeps the view inside the image and no larger than it: there is never a
    // reason to show emptiness beside the picture.
    function clampView() {
        view.w = Math.min(working.width, Math.max(working.width / MAX_ZOOM, view.w));
        view.h = Math.min(working.height, Math.max(working.height / MAX_ZOOM, view.h));
        view.x = Math.max(0, Math.min(working.width - view.w, view.x));
        view.y = Math.max(0, Math.min(working.height - view.h, view.y));
        applyViewMetrics();
    }

    // `anchor` is the image point to hold still — the pointer for a wheel, the
    // middle of the view for a button.
    function zoomBy(factor, anchor) {
        const previous = view.w;
        const at = anchor || { x: view.x + view.w / 2, y: view.y + view.h / 2 };
        view.w /= factor;
        view.h /= factor;
        clampView();
        const applied = previous / view.w;
        view.x = at.x - (at.x - view.x) / applied;
        view.y = at.y - (at.y - view.y) / applied;
        clampView();
        render();
    }

    function fitView() {
        view = { x: 0, y: 0, w: working.width, h: working.height };
        applyViewMetrics();
        render();
    }

    function fullRect() {
        return { x: 0, y: 0, w: working.width, h: working.height };
    }

    // A pointer position as the item stores it.
    function normalizedPoint(p) {
        return [+(p.x / working.width).toFixed(4), +(p.y / working.height).toFixed(4)];
    }

    // Radii are stored against the longest side, so they survive a rotation.
    function longSide() {
        return Math.max(working.width, working.height);
    }

    // The sliders speak image pixels; the item stores fractions.
    function readBrush() {
        brushRadius = longSide() * (Number(sizeSlider.value) / 1000);
        blurStrength = longSide() * (Number(strengthSlider.value) / 2000);
        sizeValue.textContent = `${Math.round(brushRadius * 2)}px`;
        strengthValue.textContent = `${Math.round(blurStrength)}px`;
    }

    function blurValue() {
        return strokes.length ? { strength: blurStrength / longSide(), strokes } : null;
    }

    function paintValue() {
        return paintList.length ? { strokes: paintList } : null;
    }

    // The strokes plus whatever is being painted right now, so a stroke shows
    // its blur as it is drawn rather than when the button comes up.
    function liveBlur() {
        const live = painting && paintingKind === "blur" ? [...strokes, painting] : strokes;
        return live.length ? { strength: blurStrength / longSide(), strokes: live } : null;
    }

    function livePaint() {
        const live = painting && paintingKind === "paint" ? [...paintList, painting] : paintList;
        return live.length ? { strokes: live } : null;
    }

    // Whether a brush is in hand, and so the pointer paints instead of cropping.
    const brushing = () => tool === "blur" || tool === "paint";

    // The crop as the item stores it: a fraction of the working image.
    function cropFraction() {
        return {
            x: rect.x / working.width,
            y: rect.y / working.height,
            w: rect.w / working.width,
            h: rect.h / working.height,
        };
    }

    // Everything that belongs to the picture being edited rather than to the
    // editor itself, so moving to the next one does not tear the panel down
    // and build it again.
    function adoptItem() {
        transform = normalizeTransform(item);
        working = renderTransformedImage(source, transform);
        strokes = (normalizeBlur(item.blur)?.strokes || []).map((stroke) => ({ r: stroke.r, pts: [...stroke.pts] }));
        paintList = copyPaint(item.paint);
        painting = null;
        drag = null;
        pan = null;
        brushAt = null;

        const storedBlur = normalizeBlur(item.blur);
        const storedPaint = normalizePaint(item.paint);
        // A brush a thirtieth of the picture across, and a blur strong enough
        // to take a face out at that size: both adjustable, neither needing to be.
        sizeSlider.value = String(Math.round((storedBlur?.strokes[0]?.r ?? storedPaint?.strokes[0]?.r ?? 0.03) * 1000));
        strengthSlider.value = String(Math.round((storedBlur?.strength ?? 0.01) * 2000));

        const initialCrop = normalizeCrop(item.crop);
        setCanvasSize();
        readBrush();
        rect = {
            x: initialCrop.x * working.width,
            y: initialCrop.y * working.height,
            w: initialCrop.w * working.width,
            h: initialCrop.h * working.height,
        };
        ratioSelect.value = "free";
        title.textContent = `Edit image ${index + 1}${node._msImages.length > 1 ? ` of ${node._msImages.length}` : ""}`;
        prevButton.disabled = index <= 0;
        nextButton.disabled = index >= node._msImages.length - 1;
    }

    adoptItem();

    const point = (event) => {
        const box = canvas.getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(working.width, view.x + (event.clientX - box.left) * view.w / box.width)),
            y: Math.max(0, Math.min(working.height, view.y + (event.clientY - box.top) * view.h / box.height)),
        };
    };

    const clamp = (r) => {
        r.w = Math.max(minSize, Math.min(working.width, r.w));
        r.h = Math.max(minSize, Math.min(working.height, r.h));
        r.x = Math.max(0, Math.min(working.width - r.w, r.x));
        r.y = Math.max(0, Math.min(working.height - r.h, r.y));
        return r;
    };

    const hit = (p) => {
        const x1 = rect.x;
        const y1 = rect.y;
        const x2 = rect.x + rect.w;
        const y2 = rect.y + rect.h;

        for (const [name, x, y] of [
            ["nw", x1, y1],
            ["ne", x2, y1],
            ["sw", x1, y2],
            ["se", x2, y2],
        ]) {
            if (Math.hypot(p.x - x, p.y - y) <= handleRadius) return name;
        }

        const withinX = p.x >= x1 - edgeHit && p.x <= x2 + edgeHit;
        const withinY = p.y >= y1 - edgeHit && p.y <= y2 + edgeHit;

        if (withinX && Math.abs(p.y - y1) <= edgeHit) return "n";
        if (withinX && Math.abs(p.y - y2) <= edgeHit) return "s";
        if (withinY && Math.abs(p.x - x1) <= edgeHit) return "w";
        if (withinY && Math.abs(p.x - x2) <= edgeHit) return "e";

        if (p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2) return "move";
        return "new";
    };

    function drawBlackHandle(cx, cy, w, h) {
        ctx.save();
        ctx.fillStyle = "#050505";
        ctx.strokeStyle = "rgba(255,255,255,.92)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(cx - w / 2, cy - h / 2, w, h, Math.min(3, h / 2, w / 2));
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    function render() {
        const sx = canvas.width / view.w;
        const sy = canvas.height / view.h;

        const x = (rect.x - view.x) * sx;
        const y = (rect.y - view.y) * sy;
        const w = rect.w * sx;
        const h = rect.h * sy;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(working, view.x, view.y, view.w, view.h, 0, 0, canvas.width, canvas.height);
        // Over a clean picture, never baked into it: a stroke can still be
        // taken back, and a rotation re-renders from the untouched source.
        const placed = {
            width: working.width, height: working.height,
            scale: canvas.width / view.w, offsetX: view.x, offsetY: view.y,
            destW: canvas.width, destH: canvas.height,
        };
        paintBlur(ctx, working, liveBlur(), placed);
        paintStrokes(ctx, livePaint(), placed);
        zoomLevel.textContent = `${Math.round(working.width / view.w * 100)}%`;
        // The size the image is, and the size this crop makes it: the question
        // the editor is open to answer, answered while the crop is dragged.
        dimensions.textContent = sizeText(working.width, working.height, cropFraction());

        ctx.fillStyle = "rgba(0,0,0,.56)";
        ctx.fillRect(0, 0, canvas.width, y);
        ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h);
        ctx.fillRect(0, y, x, h);
        ctx.fillRect(x + w, y, canvas.width - x - w, h);

        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);

        ctx.strokeStyle = "rgba(255,255,255,.45)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + w / 3, y);
        ctx.lineTo(x + w / 3, y + h);
        ctx.moveTo(x + 2 * w / 3, y);
        ctx.lineTo(x + 2 * w / 3, y + h);
        ctx.moveTo(x, y + h / 3);
        ctx.lineTo(x + w, y + h / 3);
        ctx.moveTo(x, y + 2 * h / 3);
        ctx.lineTo(x + w, y + 2 * h / 3);
        ctx.stroke();

        if (brushing() && brushAt) {
            const scale = canvas.width / view.w;
            ctx.save();
            ctx.beginPath();
            ctx.arc((brushAt.x - view.x) * scale, (brushAt.y - view.y) * scale, brushRadius * scale, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(255,255,255,.85)";
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.strokeStyle = "rgba(0,0,0,.6)";
            ctx.lineWidth = 0.75;
            ctx.stroke();
            ctx.restore();
        }

        const barLong = Math.max(34, Math.min(48, Math.min(w, h) * 0.18));
        const barThick = 9;
        const inset = 5;

        drawBlackHandle(x + w / 2, y + inset, barLong, barThick);
        drawBlackHandle(x + w / 2, y + h - inset, barLong, barThick);
        drawBlackHandle(x + inset, y + h / 2, barThick, barLong);
        drawBlackHandle(x + w - inset, y + h / 2, barThick, barLong);

        const cornerSize = 13;
        drawBlackHandle(x + inset, y + inset, cornerSize, cornerSize);
        drawBlackHandle(x + w - inset, y + inset, cornerSize, cornerSize);
        drawBlackHandle(x + inset, y + h - inset, cornerSize, cornerSize);
        drawBlackHandle(x + w - inset, y + h - inset, cornerSize, cornerSize);

        transformState.textContent = `Rotate ${transform.rotation}°${transform.flip_h ? " • H" : ""}${transform.flip_v ? " • V" : ""}`;
        flipHButton.classList.toggle("active", transform.flip_h);
        flipVButton.classList.toggle("active", transform.flip_v);
    }

    function applyTransform(next) {
        // Carry the crop through the transform instead of discarding it: map it
        // back to the source image, then forward into the new view.
        const previous = transform;
        const sourceCrop = cropViewToSource(cropFraction(), previous);
        // The strength is only along for the ride; the points are what move.
        const sourceStrokes = strokes.length ? blurViewToSource({ strength: 1, strokes }, previous) : null;
        const sourcePaint = paintList.length ? paintViewToSource({ strokes: paintList }, previous) : null;

        transform = normalizeTransform(next);
        working = renderTransformedImage(source, transform);
        setCanvasSize();

        const mapped = normalizeCrop(cropSourceToView(sourceCrop, transform));
        rect = clamp({
            x: mapped.x * working.width,
            y: mapped.y * working.height,
            w: mapped.w * working.width,
            h: mapped.h * working.height,
        });

        strokes = sourceStrokes ? (blurSourceToView(sourceStrokes, transform)?.strokes || []) : [];
        paintList = sourcePaint ? (paintSourceToView(sourcePaint, transform)?.strokes || []) : [];
        readBrush();

        // A quarter turn swaps the axes, so a locked aspect no longer applies.
        if ((previous.rotation - transform.rotation) % 180 !== 0) ratioSelect.value = "free";
        canvas.style.cursor = "crosshair";
        render();
    }

    function resizeFromDrag(p, original, mode) {
        let x1 = original.x;
        let y1 = original.y;
        let x2 = original.x + original.w;
        let y2 = original.y + original.h;

        if (mode.includes("w")) x1 = p.x;
        if (mode.includes("e")) x2 = p.x;
        if (mode.includes("n")) y1 = p.y;
        if (mode.includes("s")) y2 = p.y;

        if (x2 < x1) [x1, x2] = [x2, x1];
        if (y2 < y1) [y1, y2] = [y2, y1];

        return clamp({
            x: x1,
            y: y1,
            w: Math.max(minSize, x2 - x1),
            h: Math.max(minSize, y2 - y1),
        });
    }

    canvas.addEventListener("pointerdown", (event) => {
        // Panning is the middle button, or space held with the left one: both
        // leave the left button alone for drawing a crop.
        if (event.button === 1 || (spaceHeld && event.button === 0)) {
            pan = { x: event.clientX, y: event.clientY, from: { ...view } };
            canvas.style.cursor = "grabbing";
            canvas.setPointerCapture(event.pointerId);
            event.preventDefault();
            return;
        }

        const p = point(event);
        if (brushing()) {
            paintingKind = tool;
            painting = { r: brushRadius / longSide(), pts: [normalizedPoint(p)] };
            // A paint stroke is born with the colour and opacity in hand, and
            // keeps them: changing either later is for the next stroke.
            if (tool === "paint") Object.assign(painting, { c: paintColour, a: paintOpacity });
            brushAt = p;
            canvas.setPointerCapture(event.pointerId);
            event.preventDefault();
            render();
            return;
        }

        const mode = hit(p);
        drag = { mode, start: p, original: { ...rect } };

        if (mode === "new") {
            rect = { x: p.x, y: p.y, w: minSize, h: minSize };
        }

        canvas.style.cursor = cursorForMode(mode);
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
        render();
    });

    canvas.addEventListener("pointermove", (event) => {
        if (pan) {
            const box = canvas.getBoundingClientRect();
            view.x = pan.from.x - (event.clientX - pan.x) * view.w / box.width;
            view.y = pan.from.y - (event.clientY - pan.y) * view.h / box.height;
            clampView();
            render();
            return;
        }

        const p = point(event);

        if (brushing()) {
            brushAt = p;
            // One point per third of a brush width: a stroke is a shape, not a
            // recording of the mouse, and the workflow stores what is kept.
            if (painting) {
                const [lastX, lastY] = painting.pts.at(-1);
                const gap = Math.hypot(p.x / working.width - lastX, p.y / working.height - lastY) * longSide();
                if (gap >= brushRadius / 3) painting.pts.push(normalizedPoint(p));
            }
            render();
            return;
        }

        if (!drag) {
            canvas.style.cursor = cursorForMode(hit(p));
            return;
        }

        const o = drag.original;

        if (drag.mode === "move") {
            rect = clamp({
                ...o,
                x: o.x + p.x - drag.start.x,
                y: o.y + p.y - drag.start.y,
            });
        } else if (drag.mode === "new") {
            const x1 = Math.min(drag.start.x, p.x);
            const y1 = Math.min(drag.start.y, p.y);
            const x2 = Math.max(drag.start.x, p.x);
            const y2 = Math.max(drag.start.y, p.y);
            rect = clamp({
                x: x1,
                y: y1,
                w: Math.max(minSize, x2 - x1),
                h: Math.max(minSize, y2 - y1),
            });
        } else {
            rect = resizeFromDrag(p, o, drag.mode);
        }

        const ratio = ratioValue(ratioSelect.value, working);
        if (ratio && drag.mode !== "move") {
            rect = clamp(fitRatio(rect, ratio, working.width, working.height));
        }

        render();
    });

    const endDrag = (event) => {
        if (event?.pointerId != null && canvas.hasPointerCapture?.(event.pointerId)) {
            try { canvas.releasePointerCapture(event.pointerId); } catch (_) {}
        }
        if (painting) {
            if (paintingKind === "paint") {
                paintList.push(painting);
                if (paintList.length > MAX_PAINT_STROKES) paintList = paintList.slice(-MAX_PAINT_STROKES);
            } else {
                strokes.push(painting);
                if (strokes.length > MAX_BLUR_STROKES) strokes = strokes.slice(-MAX_BLUR_STROKES);
            }
            lastBrush = paintingKind;
            painting = null;
            render();
        }
        drag = null;
        if (pan) {
            pan = null;
            canvas.style.cursor = spaceHeld ? "grab" : "crosshair";
            return;
        }
        if (event) canvas.style.cursor = cursorForMode(hit(point(event)));
    };

    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", () => {
        painting = null;
        drag = null;
        pan = null;
        canvas.style.cursor = spaceHeld ? "grab" : "crosshair";
    });
    canvas.addEventListener("pointerleave", (event) => {
        if (brushing()) {
            // The ring belongs to the pointer, so it leaves with it.
            if (!painting) {
                brushAt = null;
                render();
            }
            return;
        }
        if (!drag && !pan) canvas.style.cursor = cursorForMode(hit(point(event)));
    });
    // Middle-click otherwise starts the browser's scroll-by-drag.
    canvas.addEventListener("auxclick", (event) => event.preventDefault());

    // A message where the hint is, for as long as it is worth reading: the
    // editor covers the screen, so this is where the eye already is.
    let sayTimer = null;
    const say = (message) => {
        clearTimeout(sayTimer);
        hint.textContent = message || hintText;
        hint.classList.toggle("said", !!message);
        if (message) sayTimer = setTimeout(() => say(null), 4000);
    };

    // The pixels themselves, at their own size: `working` carries the rotation
    // and the flip, and the box is the server's, so what lands on the clipboard
    // is what the run would cut.
    const cropCanvas = () => {
        const box = cropPixelBox(working.width, working.height, cropFraction());
        const out = document.createElement("canvas");
        out.width = box.w;
        out.height = box.h;
        out.getContext("2d").drawImage(working, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
        return out;
    };

    const copy = async (make, what) => {
        const unavailable = clipboardUnavailable();
        if (unavailable) {
            say(unavailable);
            return;
        }
        const image = make();
        try {
            await writePngToClipboard(canvasPngBlob(image));
            say(`${what} copied — ${image.width} × ${image.height}`);
        } catch (error) {
            say(`Copy failed: ${error?.message || error}`);
        }
    };

    // The editor's own menu. Without it the browser offers its "Copy image",
    // which hands over the canvas as drawn — the darkened surround, the crop
    // outline and the thirds grid baked into the picture.
    let menu = null;
    const closeMenu = () => {
        menu?.remove();
        menu = null;
    };
    canvas.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        menu = document.createElement("div");
        menu.className = "ms-crop-menu";
        menu.style.left = `${Math.min(event.clientX, innerWidth - 210)}px`;
        menu.style.top = `${Math.min(event.clientY, innerHeight - 90)}px`;
        for (const [label, run] of [
            ["Copy crop to clipboard", () => copy(cropCanvas, "Crop")],
            ["Copy whole image to clipboard", () => copy(() => working, "Image")],
        ]) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.addEventListener("click", () => {
                closeMenu();
                run();
            });
            menu.appendChild(button);
        }
        menu.addEventListener("contextmenu", (e) => e.preventDefault());
        overlay.appendChild(menu);
    });
    // Dismissing the menu is all a click does: the backdrop handler below
    // consults this so the same press does not also close the editor.
    let menuWasOpen = false;
    overlay.addEventListener("pointerdown", (event) => {
        menuWasOpen = !!menu;
        if (menu && !menu.contains(event.target)) closeMenu();
    });

    function setTool(next) {
        tool = next;
        cropButton.classList.toggle("active", next === "crop");
        blurButton.classList.toggle("active", next === "blur");
        paintButton.classList.toggle("active", next === "paint");
        brushBar.hidden = next === "crop";
        forBlur.hidden = next !== "blur";
        forPaint.hidden = next !== "paint";
        clearButton.textContent = next === "paint" ? "Clear paint" : "Clear blur";
        brushAt = null;
        canvas.style.cursor = next === "crop" ? "crosshair" : "none";
        hintText = next === "blur" ? BLUR_HINT : next === "paint" ? PAINT_HINT : CROP_HINT;
        say(null);
        render();
    }
    cropButton.onclick = () => setTool("crop");
    blurButton.onclick = () => setTool("blur");
    paintButton.onclick = () => setTool("paint");
    sizeSlider.oninput = () => {
        readBrush();
        render();
    };
    strengthSlider.oninput = () => {
        readBrush();
        render();
    };

    // The colour in hand: a swatch, or anything the colour input offers. The
    // swatch that matches lights up; a colour of the input's own lights none.
    const swatches = SWATCHES.map(([colour, name]) => {
        const swatch = document.createElement("button");
        swatch.type = "button";
        swatch.className = "swatch";
        swatch.title = name;
        swatch.style.background = colour;
        swatch.onclick = () => chooseColour(colour);
        swatchBar.appendChild(swatch);
        return [colour, swatch];
    });
    function chooseColour(colour) {
        paintColour = colour.toLowerCase();
        colourInput.value = paintColour;
        for (const [value, swatch] of swatches) swatch.classList.toggle("active", value === paintColour);
    }
    colourInput.oninput = () => chooseColour(colourInput.value);
    // The two things paint is for, a click each: what they set is what the
    // controls beside them show, and both stay adjustable.
    const usePaint = (colour, opacity) => {
        chooseColour(colour);
        opacitySlider.value = String(Math.round(opacity * 100));
        opacitySlider.oninput();
    };
    overlay.querySelector(".paint-cover").onclick = () => usePaint("#808080", 1);
    overlay.querySelector(".paint-mark").onclick = () => usePaint("#ff0000", 0.4);
    opacitySlider.oninput = () => {
        paintOpacity = Number(opacitySlider.value) / 100;
        opacityValue.textContent = `${Math.round(paintOpacity * 100)}%`;
    };
    opacitySlider.value = String(Math.round(paintOpacity * 100));
    opacitySlider.oninput();
    chooseColour(paintColour);

    // Strokes are taken back from the brush in hand; with the crop tool on,
    // from whichever brush was used last, then the other.
    const undoable = () => {
        if (tool === "paint") return paintList.length ? "paint" : null;
        if (tool === "blur") return strokes.length ? "blur" : null;
        const order = lastBrush === "paint" ? ["paint", "blur"] : ["blur", "paint"];
        return order.find((kind) => (kind === "paint" ? paintList : strokes).length) || null;
    };
    const undoStroke = () => {
        const kind = undoable();
        if (kind === "paint") paintList = paintList.slice(0, -1);
        else if (kind === "blur") strokes = strokes.slice(0, -1);
        else return;
        render();
    };
    overlay.querySelector(".blur-undo").onclick = undoStroke;
    clearButton.onclick = () => {
        if (tool === "paint") paintList = [];
        else strokes = [];
        render();
    };

    overlay.querySelector(".zoom-in").onclick = () => zoomBy(1.5, null);
    overlay.querySelector(".zoom-out").onclick = () => zoomBy(1 / 1.5, null);
    overlay.querySelector(".zoom-fit").onclick = () => fitView();

    // The wheel zooms around the pointer, so the detail under it stays put.
    canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        event.stopPropagation();
        zoomBy(event.deltaY < 0 ? 1.2 : 1 / 1.2, point(event));
    }, { passive: false });

    const onSpace = (event, down) => {
        if (event.code !== "Space" && event.key !== " ") return;
        // A focused select or field keeps the key for itself.
        if (isTextEntry(event.target)) return;
        event.preventDefault();
        swallowKey(event);
        if (spaceHeld === down) return;
        spaceHeld = down;
        if (!pan) canvas.style.cursor = down ? "grab" : "crosshair";
    };
    const onSpaceDown = (event) => onSpace(event, true);
    const onSpaceUp = (event) => onSpace(event, false);
    document.addEventListener("keydown", onSpaceDown, true);
    document.addEventListener("keyup", onSpaceUp, true);

    ratioSelect.addEventListener("change", () => {
        const ratio = ratioValue(ratioSelect.value, working);
        if (ratio) rect = clamp(fitRatio(rect, ratio, working.width, working.height));
        render();
    });

    overlay.querySelector(".rotate-left").onclick = () => {
        applyTransform({ ...transform, rotation: transform.rotation - 90 });
    };
    overlay.querySelector(".rotate-right").onclick = () => {
        applyTransform({ ...transform, rotation: transform.rotation + 90 });
    };
    flipHButton.onclick = () => applyTransform({ ...transform, flip_h: !transform.flip_h });
    flipVButton.onclick = () => applyTransform({ ...transform, flip_v: !transform.flip_v });

    // Whether Apply would change anything: what a backdrop click is about to
    // throw away.
    const changed = () => {
        const saved = normalizeTransform(item);
        if (saved.rotation !== transform.rotation || saved.flip_h !== transform.flip_h || saved.flip_v !== transform.flip_v) {
            return true;
        }
        if (JSON.stringify(normalizeBlur(item.blur)) !== JSON.stringify(normalizeBlur(blurValue()))) {
            return true;
        }
        if (JSON.stringify(normalizePaint(item.paint)) !== JSON.stringify(normalizePaint(paintValue()))) {
            return true;
        }
        const crop = normalizeCrop(item.crop);
        const now = cropFraction();
        return ["x", "y", "w", "h"].some((k) => Math.abs(crop[k] - now[k]) > CROPPED_EPSILON);
    };

    let keyHandler = null;
    let closed = false;
    // The handle the node keeps, so a removed node (or a second edit) can close
    // the editor, and the tests can drive it.
    const handle = {
        overlay, canvas, changed, close: () => {},
        onKey: (event) => keyHandler?.(event),
        view: () => ({ ...view }),
        index: () => index,
        step: (delta) => step(delta),
    };
    const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(sayTimer);
        closeMenu();
        if (keyHandler) document.removeEventListener("keydown", keyHandler, true);
        document.removeEventListener("keydown", onSpaceDown, true);
        document.removeEventListener("keyup", onSpaceUp, true);
        overlay.remove();
        if (node._msEditor === handle) node._msEditor = null;
    };
    handle.close = close;
    node._msEditor = handle;

    overlay.querySelector(".cancel").onclick = close;
    overlay.querySelector(".reset-crop").onclick = () => {
        rect = fullRect();
        ratioSelect.value = "free";
        render();
    };
    overlay.querySelector(".reset-all").onclick = () => {
        applyTransform({ rotation: 0, flip_h: false, flip_v: false });
    };
    function applyEdits() {
        item.rotation = transform.rotation;
        item.flip_h = transform.flip_h;
        item.flip_v = transform.flip_v;
        // Through the same check the server applies, so what is stored is
        // exactly what will be painted — capped, clamped and no more.
        const blur = normalizeBlur(blurValue());
        if (blur) item.blur = { strength: +blur.strength.toFixed(6), strokes: blur.strokes };
        else delete item.blur;
        const paint = normalizePaint(paintValue());
        if (paint) item.paint = paint;
        else delete item.paint;
        const fraction = cropFraction();
        item.crop = {
            x: +fraction.x.toFixed(6),
            y: +fraction.y.toFixed(6),
            w: +fraction.w.toFixed(6),
            h: +fraction.h.toFixed(6),
        };
        node._msTransformedCache?.clear();
        commitImages(node);
    }

    overlay.querySelector(".apply").onclick = () => {
        applyEdits();
        close();
    };

    // The list is usually worked through one card after another, and closing
    // the editor to find the next one is most of that work. Keep what was
    // edited — only when something was — and move along.
    async function step(delta) {
        const next = index + delta;
        if (closed || next < 0 || next >= node._msImages.length) return;
        if (changed()) applyEdits();
        const token = ++loading;
        let loaded;
        try {
            loaded = await loadSource(node._msImages[next]);
        } catch (error) {
            say(error?.message || String(error));
            return;
        }
        // A slower load must not land on top of a later one, and the editor
        // may have closed while it was in the air.
        if (closed || token !== loading) return;
        index = next;
        item = node._msImages[index];
        source = loaded;
        adoptItem();
        fitView();
        say(null);
    }
    prevButton.onclick = () => step(-1);
    nextButton.onclick = () => step(1);

    overlay.addEventListener("mousedown", (event) => {
        if (event.target !== overlay || event.button !== 0 || menuWasOpen) return;
        // A click beside the panel used to throw the edit away without a word;
        // ask first, but only when there is something to lose.
        if (changed() && !confirm("Discard the crop and rotation changes to this image?")) return;
        close();
    });

    keyHandler = (event) => {
        if (closed) return;
        // Swallowed whether the editor uses the key or not: the canvas
        // underneath must not delete the node or reload the graph while a modal
        // is open.
        if (isModalKey(event)) swallowKey(event);
        if (isTextEntry(event.target)) {
            if (event.key === "Escape") {
                event.target.blur?.();
                event.preventDefault();
            }
            return;
        }
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            swallowKey(event);
            event.preventDefault();
            step(event.key === "ArrowLeft" ? -1 : 1);
        } else if ((event.ctrlKey || event.metaKey) && /^z$/i.test(event.key) && undoable()) {
            swallowKey(event);
            event.preventDefault();
            undoStroke();
        } else if (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "_" || event.key === "0") {
            swallowKey(event);
            event.preventDefault();
            if (event.key === "0") fitView();
            else zoomBy(event.key === "-" || event.key === "_" ? 1 / 1.5 : 1.5, null);
        } else if (event.key === "Escape") {
            // The menu first: Escape closes what is on top, not the editor
            // under it.
            if (menu) closeMenu();
            else close();
            event.preventDefault();
        } else if (isModalKey(event)) {
            event.preventDefault();
        }
    };
    // Capture phase: ComfyUI's handlers are on the document and the window, so
    // this is where propagation has to stop.
    document.addEventListener("keydown", keyHandler, true);
    overlay.focus?.();

    render();
    return handle;
}
