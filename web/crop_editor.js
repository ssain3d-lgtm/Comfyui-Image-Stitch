import { imageUrl, normalizeCrop, normalizeTransform, renderTransformedImage, syncImages } from "./shared.js";

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
.ms-crop-spacer{flex:1}.ms-crop-hint{font-size:12px;color:#aaa}.ms-transform-state{font-size:12px;color:#9aa0a6;min-width:130px}
`;
    document.head.appendChild(style);
}

function ratioValue(name, image) {
    if (name === "original") return image.width / image.height;
    return { "1:1": 1, "4:3": 4 / 3, "3:2": 3 / 2, "16:9": 16 / 9, "9:16": 9 / 16 }[name] || null;
}

function fitRatio(rect, ratio, imageW, imageH) {
    if (!ratio) return rect;
    let w = rect.w;
    let h = w / ratio;
    if (h > rect.h) { h = rect.h; w = h * ratio; }
    return {
        x: Math.max(0, Math.min(imageW - w, rect.x + (rect.w - w) / 2)),
        y: Math.max(0, Math.min(imageH - h, rect.y + (rect.h - h) / 2)),
        w, h,
    };
}

export async function openCropEditor(node, index) {
    const item = node._msImages[index];
    if (!item) return;
    installStyles();

    const source = new Image();
    source.crossOrigin = "anonymous";
    source.src = imageUrl(item);
    await new Promise((resolve, reject) => {
        source.onload = resolve;
        source.onerror = () => reject(new Error("Could not load image for cropping."));
    });

    const overlay = document.createElement("div");
    overlay.className = "ms-crop-overlay";
    overlay.innerHTML = `
      <div class="ms-crop-panel" role="dialog" aria-modal="true">
        <div class="ms-crop-head"><span>Edit image ${index + 1}</span><span class="dimensions" style="font-size:12px;color:#aaa"></span></div>
        <div class="ms-crop-stage"><canvas class="ms-crop-canvas"></canvas></div>
        <div class="ms-crop-controls">
          <button class="rotate-left" title="Rotate 90° left">↶ 90°</button>
          <button class="rotate-right" title="Rotate 90° right">↷ 90°</button>
          <button class="flip-h">Flip H</button>
          <button class="flip-v">Flip V</button>
          <span class="ms-transform-state"></span>
          <label>Aspect <select class="ratio"><option value="free">Free</option><option value="original">Original</option><option>1:1</option><option>4:3</option><option>3:2</option><option>16:9</option><option>9:16</option></select></label>
          <button class="reset-crop">Reset crop</button>
          <button class="reset-all">Reset all</button>
          <span class="ms-crop-hint">Rotate/flip resets crop • drag image area to crop</span>
          <span class="ms-crop-spacer"></span><button class="cancel">Cancel</button><button class="primary apply">Apply</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const canvas = overlay.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    const ratioSelect = overlay.querySelector(".ratio");
    const dimensions = overlay.querySelector(".dimensions");
    const transformState = overlay.querySelector(".ms-transform-state");
    const flipHButton = overlay.querySelector(".flip-h");
    const flipVButton = overlay.querySelector(".flip-v");
    const maxW = Math.min(1000, innerWidth * 0.82), maxH = Math.min(660, innerHeight * 0.66);

    let transform = normalizeTransform(item);
    let working = renderTransformedImage(source, transform);
    let rect;
    let scale = 1;
    let drag = null;
    let handleRadius = 10;
    let minSize = 4;

    function setCanvasSize() {
        scale = Math.min(1, maxW / working.width, maxH / working.height);
        canvas.width = Math.max(1, Math.round(working.width * scale));
        canvas.height = Math.max(1, Math.round(working.height * scale));
        handleRadius = Math.max(10, 12 / scale);
        minSize = Math.max(4, 8 / scale);
        dimensions.textContent = `${working.width} × ${working.height}`;
    }

    function fullRect() {
        return { x: 0, y: 0, w: working.width, h: working.height };
    }

    const initialCrop = normalizeCrop(item.crop);
    setCanvasSize();
    rect = {
        x: initialCrop.x * working.width,
        y: initialCrop.y * working.height,
        w: initialCrop.w * working.width,
        h: initialCrop.h * working.height,
    };

    const point = (event) => {
        const box = canvas.getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(working.width, (event.clientX - box.left) * working.width / box.width)),
            y: Math.max(0, Math.min(working.height, (event.clientY - box.top) * working.height / box.height)),
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
        for (const [name, x, y] of [["nw",rect.x,rect.y],["ne",rect.x+rect.w,rect.y],["sw",rect.x,rect.y+rect.h],["se",rect.x+rect.w,rect.y+rect.h]]) {
            if (Math.hypot(p.x - x, p.y - y) <= handleRadius) return name;
        }
        return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h ? "move" : "new";
    };

    function render() {
        const sx = canvas.width / working.width, sy = canvas.height / working.height;
        const x = rect.x * sx, y = rect.y * sy, w = rect.w * sx, h = rect.h * sy;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(working, 0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "rgba(0,0,0,.56)";
        ctx.fillRect(0,0,canvas.width,y); ctx.fillRect(0,y+h,canvas.width,canvas.height-y-h); ctx.fillRect(0,y,x,h); ctx.fillRect(x+w,y,canvas.width-x-w,h);
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.strokeRect(x,y,w,h);
        ctx.strokeStyle = "rgba(255,255,255,.45)"; ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(x+w/3,y);ctx.lineTo(x+w/3,y+h);ctx.moveTo(x+2*w/3,y);ctx.lineTo(x+2*w/3,y+h);
        ctx.moveTo(x,y+h/3);ctx.lineTo(x+w,y+h/3);ctx.moveTo(x,y+2*h/3);ctx.lineTo(x+w,y+2*h/3);ctx.stroke();
        ctx.fillStyle="#fff"; [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([a,b])=>ctx.fillRect(a-4,b-4,8,8));
        transformState.textContent = `Rotate ${transform.rotation}°${transform.flip_h ? " • H" : ""}${transform.flip_v ? " • V" : ""}`;
        flipHButton.classList.toggle("active", transform.flip_h);
        flipVButton.classList.toggle("active", transform.flip_v);
    }

    function applyTransform(next) {
        transform = normalizeTransform(next);
        working = renderTransformedImage(source, transform);
        setCanvasSize();
        rect = fullRect();
        ratioSelect.value = "free";
        render();
    }

    canvas.addEventListener("pointerdown", (event) => {
        const p = point(event); drag = { mode: hit(p), start: p, original: { ...rect } };
        if (drag.mode === "new") rect = { x: p.x, y: p.y, w: minSize, h: minSize };
        canvas.setPointerCapture(event.pointerId); render();
    });
    canvas.addEventListener("pointermove", (event) => {
        if (!drag) return;
        const p = point(event), o = drag.original;
        if (drag.mode === "move") rect = clamp({ ...o, x: o.x + p.x - drag.start.x, y: o.y + p.y - drag.start.y });
        else if (drag.mode === "new") {
            const x1=Math.min(drag.start.x,p.x), y1=Math.min(drag.start.y,p.y), x2=Math.max(drag.start.x,p.x), y2=Math.max(drag.start.y,p.y);
            rect=clamp({x:x1,y:y1,w:Math.max(minSize,x2-x1),h:Math.max(minSize,y2-y1)});
        } else {
            let x1=o.x,y1=o.y,x2=o.x+o.w,y2=o.y+o.h;
            if(drag.mode.includes("w"))x1=p.x;if(drag.mode.includes("e"))x2=p.x;if(drag.mode.includes("n"))y1=p.y;if(drag.mode.includes("s"))y2=p.y;
            if(x2<x1)[x1,x2]=[x2,x1];if(y2<y1)[y1,y2]=[y2,y1];
            rect=clamp({x:x1,y:y1,w:Math.max(minSize,x2-x1),h:Math.max(minSize,y2-y1)});
        }
        const ratio=ratioValue(ratioSelect.value,working); if(ratio&&drag.mode!=="move")rect=clamp(fitRatio(rect,ratio,working.width,working.height)); render();
    });
    canvas.addEventListener("pointerup",()=>drag=null); canvas.addEventListener("pointercancel",()=>drag=null);
    ratioSelect.addEventListener("change",()=>{const ratio=ratioValue(ratioSelect.value,working);if(ratio)rect=clamp(fitRatio(rect,ratio,working.width,working.height));render();});

    overlay.querySelector(".rotate-left").onclick = () => applyTransform({ ...transform, rotation: transform.rotation - 90 });
    overlay.querySelector(".rotate-right").onclick = () => applyTransform({ ...transform, rotation: transform.rotation + 90 });
    flipHButton.onclick = () => applyTransform({ ...transform, flip_h: !transform.flip_h });
    flipVButton.onclick = () => applyTransform({ ...transform, flip_v: !transform.flip_v });

    let keyHandler = null;
    const close = () => { if (keyHandler) document.removeEventListener("keydown", keyHandler); overlay.remove(); };
    overlay.querySelector(".cancel").onclick=close;
    overlay.querySelector(".reset-crop").onclick=()=>{rect=fullRect();ratioSelect.value="free";render();};
    overlay.querySelector(".reset-all").onclick=()=>applyTransform({rotation:0,flip_h:false,flip_v:false});
    overlay.querySelector(".apply").onclick=()=>{
        item.rotation=transform.rotation;
        item.flip_h=transform.flip_h;
        item.flip_v=transform.flip_v;
        item.crop={x:+(rect.x/working.width).toFixed(6),y:+(rect.y/working.height).toFixed(6),w:+(rect.w/working.width).toFixed(6),h:+(rect.h/working.height).toFixed(6)};
        node._msTransformedCache?.clear();
        syncImages(node); close();
    };
    overlay.addEventListener("mousedown",(e)=>{if(e.target===overlay)close();});
    keyHandler=(e)=>{if(e.key==="Escape")close();};document.addEventListener("keydown",keyHandler);render();
}
