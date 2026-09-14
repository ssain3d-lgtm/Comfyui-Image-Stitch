// A DOM rendering of the node's list for ComfyUI's Vue "Nodes 2.0" mode.
//
// In that mode the node body is a Vue component: onDrawForeground and
// onMouseDown never run, so the canvas-drawn status line, toolbar, preview
// band, cards and size panel simply do not exist. This view shows the same
// state through a DOM widget and routes every button to the same functions
// the canvas UI calls; it is installed only while that mode is on, so the
// classic canvas keeps its own drawing.
import { columnsForWidth, isCropped, isTransformed, normalizeTransform, THUMB_GAP } from "./shared.js";
import { formatTime } from "./frame_picker.js";

// The "$$" prefix marks a widget the frontend must treat as a pseudo widget:
// it belongs to the view, not to the node's inputs, and must never reach
// widgets_values, where it would shift every saved value after it.
export const DOM_VIEW_WIDGET = "$$multi_stitch_view";
const PREVIEW_H = 150;
const CARD_H = 92;
const PANEL_H = 198;
const TOOLBAR_ROW_H = 30;
const REFRESH_MS = 300;

export function vueNodesEnabled(app) {
    try {
        return app?.extensionManager?.setting?.get?.("Comfy.VueNodes.Enabled") === true;
    } catch {
        return false;
    }
}

let stylesInstalled = false;
function installStyles() {
    if (stylesInstalled || typeof document === "undefined") return;
    stylesInstalled = true;
    const style = document.createElement("style");
    style.textContent = `
/* The rules below set display on elements the view hides with .hidden, and
   they outrank the browser's [hidden] rule, so say it here. */
.ms-dom-view [hidden]{display:none!important}
.ms-dom-view{box-sizing:border-box;width:100%;font:12px/1.3 sans-serif;color:#d0d0d0;display:flex;flex-direction:column;gap:6px;padding:4px 2px;user-select:none}
.ms-dom-view .status{color:#b8b8b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ms-dom-view .toolbar{display:flex;gap:4px;flex-wrap:wrap}
.ms-dom-view button{background:#3a3a3a;border:1px solid #4a4a4a;color:#e6e6e6;border-radius:4px;padding:3px 8px;cursor:pointer;font:inherit;line-height:1.2}
.ms-dom-view button:hover{background:#474747}
.ms-dom-view button:disabled{opacity:.45;cursor:default}
.ms-dom-view button.on{background:#2f6b45;border-color:#4ade80;color:#c9f7d9}
.ms-dom-view canvas.preview{width:100%;height:${PREVIEW_H}px;display:block;background:#101010;border:1px solid #333;border-radius:3px}
.ms-dom-view .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:${THUMB_GAP}px}
.ms-dom-view .card{position:relative;height:${CARD_H}px;background:#171717;border:1px solid #555;border-radius:3px;overflow:hidden;cursor:grab}
.ms-dom-view .card.dragging{opacity:.55}
.ms-dom-view .card.drop-before,.ms-dom-view .card.drop-after{box-shadow:inset 3px 0 0 #8ab4f8}
.ms-dom-view .card.drop-after{box-shadow:inset -3px 0 0 #8ab4f8}
.ms-dom-view .card.edited{border-color:#f6b73c}
.ms-dom-view .card canvas.thumb{position:absolute;inset:3px;width:calc(100% - 6px);height:calc(100% - 6px);cursor:pointer}
.ms-dom-view .card .text{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;color:#8d8d8d;padding:4px 26px;cursor:pointer}
.ms-dom-view .card .text.failed{color:#f08a8a}
.ms-dom-view .card .badges{position:absolute;left:3px;top:3px;display:flex;gap:3px;pointer-events:none}
.ms-dom-view .card .badges span{background:rgba(0,0,0,.72);color:#fff;padding:2px 6px;border-radius:2px;font-size:11px}
.ms-dom-view .card .badges span.edit{color:#f6b73c}
.ms-dom-view .card .badges span.video{color:#9ad0ff}
.ms-dom-view .card .btn{position:absolute;background:rgba(0,0,0,.76);border:0;color:#fff;padding:0;width:20px;height:19px;font-size:13px;line-height:19px;text-align:center;border-radius:2px}
.ms-dom-view .card .btn.remove{right:3px;top:3px}
.ms-card-menu{position:fixed;z-index:10000;background:#2b2b2b;border:1px solid #4a4a4a;border-radius:4px;padding:3px;display:flex;flex-direction:column;min-width:150px;box-shadow:0 4px 14px rgba(0,0,0,.5);font:12px sans-serif}
.ms-card-menu button{background:transparent;border:0;color:#e6e6e6;text-align:left;padding:5px 9px;border-radius:3px;cursor:pointer;font:inherit}
.ms-card-menu button:hover{background:#3d5a80}
.ms-dom-view .card .label{position:absolute;left:24px;right:24px;bottom:3px;background:rgba(0,0,0,.6);color:#9ad0ff;font-size:11px;padding:2px 4px;border-radius:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;pointer-events:none}
.ms-dom-view .empty{border:1px dashed #666;border-radius:3px;height:${CARD_H}px;display:flex;align-items:center;justify-content:center;text-align:center;color:#8f8f8f;cursor:pointer;padding:0 12px}
.ms-dom-view .empty.over{border-color:#8ab4f8;color:#c8d8ff}
.ms-dom-view canvas.panel{width:100%;height:${PANEL_H}px;display:block}
`;
    document.head.appendChild(style);
}

// Paint after layout where the browser offers it, and straight away where it
// does not: an undeclared requestAnimationFrame is a ReferenceError, not
// undefined, so it cannot simply be called optionally.
function paintSoon(paint) {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(paint);
    else paint();
}

function button(label, title, onClick) {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    if (title) el.title = title;
    el.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick(event);
    });
    return el;
}

// Draws `image` inside `canvas` at the device pixel ratio, contained and
// centred, through the same helper the canvas cards use.
function paintThumb(canvas, draw) {
    const rect = canvas.getBoundingClientRect?.() || { width: 124, height: 86 };
    const scale = (typeof devicePixelRatio === "number" ? devicePixelRatio : 1) || 1;
    const w = Math.max(1, Math.round((rect.width || 124) * scale));
    const h = Math.max(1, Math.round((rect.height || 86) * scale));
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform?.(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, w / scale, h / scale);
    draw(ctx, { x: 0, y: 0, w: w / scale, h: h / scale });
}

// The view's height: what the widget asks the node for.
// What the view needs when it cannot be measured — the first render, and the
// tests. Once it is on the page the real height is read from the DOM instead:
// the toolbar wraps at narrow widths and large UI scales, and guessing one row
// for it leaves the node short.
function viewHeight(node, actions) {
    const count = actions.items(node).length + actions.videos(node).length;
    const rows = Math.max(1, Math.ceil(count / columnsForWidth(node?.size?.[0])));
    return 22 + TOOLBAR_ROW_H + (actions.previewOn(node) && actions.items(node).length ? PREVIEW_H + 8 : 0)
        + rows * (CARD_H + THUMB_GAP) + (actions.sizePanelOn(node) ? PANEL_H + 8 : 0) + 8;
}

// The height the rendered view actually occupies, or null where the DOM cannot
// say (the test harness, a view not yet attached).
function measuredHeight(root) {
    const height = Math.round(Number(root?.scrollHeight) || 0);
    return height > 0 ? height : null;
}

export function domView(node) {
    return node?._msDomView || null;
}

// Installs the DOM widget on `node` (once). `actions` supplies every state
// reader and every action; the view never reaches into the node itself.
export function installDomView(node, actions) {
    if (node._msDomView) return node._msDomView;
    if (typeof node.addDOMWidget !== "function" || typeof document === "undefined") return null;
    installStyles();

    const root = document.createElement("div");
    root.className = "ms-dom-view";
    const status = document.createElement("div");
    status.className = "status";
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    const preview = document.createElement("canvas");
    preview.className = "preview";
    const cards = document.createElement("div");
    cards.className = "cards";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Drop or add images or a video (paste images with Ctrl+V while the node is selected)";
    const panel = document.createElement("canvas");
    panel.className = "panel";
    panel.title = "Click a shape to set the width / height outputs";
    // The panel is drawn by the same function the canvas uses, so a click on it
    // is answered from the same geometry: the point is converted into the
    // panel's own coordinates and handed over.
    panel.addEventListener("click", (event) => {
        const box = panel.getBoundingClientRect?.();
        if (!box) return;
        actions.sizePanelClick?.(node, {
            x: (event.clientX ?? 0) - box.left,
            y: (event.clientY ?? 0) - box.top,
            w: box.width,
            h: box.height,
        });
    });
    root.append(status, toolbar, preview, cards, empty, panel);

    const view = { node, root, widget: null, timer: null, alive: true, height: 0 };
    node._msDomView = view;

    const buttons = {
        add: button("+ Add", "Add images or a video (files)", () => actions.add(node)),
        clear: button("Clear", "Remove every image", () => actions.clear(node)),
        copy: button("⧉ Copy", "Copy the stitched result to the clipboard", () => actions.copy(node)),
        undo: button("↶", "Undo (this node's list)", () => actions.undo(node)),
        redo: button("↷", "Redo", () => actions.redo(node)),
        preview: button("Preview", "Show the composite preview band", () => actions.togglePreview(node)),
        options: button("Options ▸", "Show the advanced widgets", () => actions.toggleOptions(node)),
        gallery: button("🖼 Gallery", "Compositions this node has stitched; load one back", () => actions.openGallery(node)),
        size: button("📐 Size", "Width / height outputs and the size panel", () => actions.toggleSizePanel(node)),
    };
    toolbar.append(...Object.values(buttons));

    empty.addEventListener("click", () => actions.add(node));
    const accept = (event) => {
        const files = Array.from(event.dataTransfer?.files || []);
        if (!files.length) return false;
        event.preventDefault();
        event.stopPropagation();
        return files;
    };
    root.addEventListener("dragover", (event) => {
        if (Array.from(event.dataTransfer?.items || []).some((item) => item.kind === "file")) {
            event.preventDefault();
            event.stopPropagation();
            empty.classList?.add("over");
        }
    });
    root.addEventListener("dragleave", () => empty.classList?.remove("over"));
    root.addEventListener("drop", (event) => {
        empty.classList?.remove("over");
        const files = accept(event);
        if (files) actions.addFiles(node, files);
    });

    // Which card is in hand, and the marks showing where it would land.
    let drag = null;
    const clearDropMarks = () => {
        for (const card of cards.children || []) card.classList?.remove("drop-before", "drop-after", "dragging");
    };

    // Right-click on a card. The canvas puts these on LiteGraph's node menu,
    // which cannot tell which card was under the pointer here, so the DOM
    // rendering opens its own small popup instead.
    const closeMenu = () => {
        view.menu?.remove?.();
        view.menu = null;
    };
    const openMenu = (event, entries) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        closeMenu();
        const menu = document.createElement("div");
        menu.className = "ms-card-menu";
        menu.style.left = `${event.clientX ?? 0}px`;
        menu.style.top = `${event.clientY ?? 0}px`;
        for (const [label, run] of entries) {
            const entry = document.createElement("button");
            entry.textContent = label;
            entry.addEventListener("click", (click) => {
                click.stopPropagation?.();
                closeMenu();
                run();
            });
            menu.appendChild(entry);
        }
        menu.addEventListener("contextmenu", (e) => e.preventDefault?.());
        document.body.appendChild(menu);
        view.menu = menu;
        // Not this very event: the press that opened it would close it again.
        setTimeout(() => {
            if (view.menu === menu) window.addEventListener("pointerdown", closeMenu, { once: true, capture: true });
        }, 0);
    };

    const cardFor = (item, index) => {
        const el = document.createElement("div");
        el.className = `card${isCropped(item.crop) || isTransformed(item) ? " edited" : ""}`;
        const state = actions.thumb(node, item);
        if (state.ready) {
            const canvas = document.createElement("canvas");
            canvas.className = "thumb";
            canvas.title = "Click to crop, rotate or flip";
            canvas.addEventListener("click", () => actions.edit(node, index));
            el.appendChild(canvas);
            paintSoon(() => paintThumb(canvas, (ctx, rect) => actions.drawThumb(ctx, state.image, item.crop, rect)));
        } else {
            const text = document.createElement("div");
            text.className = `text${state.failed ? " failed" : ""}`;
            text.textContent = state.failed ? (state.message || "Load failed · click to relink") : "Loading…";
            text.addEventListener("click", () => actions.edit(node, index));
            el.appendChild(text);
        }
        const badges = document.createElement("div");
        badges.className = "badges";
        const badge = (text, cls = "") => {
            const span = document.createElement("span");
            if (cls) span.className = cls;
            span.textContent = text;
            badges.appendChild(span);
        };
        badge(String(index + 1));
        if (isCropped(item.crop)) badge("✂", "edit");
        if (isTransformed(item)) {
            const t = normalizeTransform(item);
            badge(`${t.rotation}°${t.flip_h ? "H" : ""}${t.flip_v ? "V" : ""}`, "edit");
        }
        el.appendChild(badges);
        // The one button an image card keeps, in the same corner as the video
        // card's. It must not become a drag, so it never starts one.
        const remove = button("×", "Remove this image", () => actions.remove(node, index));
        remove.className = "btn remove";
        remove.draggable = false;
        el.appendChild(remove);
        el.title = "Click to edit · drag to reorder · right-click for more";
        // Reordering is the card itself, so no handle covers the picture. The
        // card the pointer is over shows on which side the held one would land.
        el.draggable = true;
        el.addEventListener("dragstart", (event) => {
            drag = index;
            el.classList?.add("dragging");
            try {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", String(index));
            } catch (_) {}
        });
        el.addEventListener("dragend", () => { drag = null; clearDropMarks(); });
        el.addEventListener("dragover", (event) => {
            if (drag === null || drag === index) return;
            event.preventDefault?.();
            event.stopPropagation?.();
            clearDropMarks();
            el.classList?.add(drag < index ? "drop-after" : "drop-before");
        });
        el.addEventListener("dragleave", () => el.classList?.remove("drop-before", "drop-after"));
        el.addEventListener("drop", (event) => {
            if (drag === null || drag === index) return;
            event.preventDefault?.();
            event.stopPropagation?.();
            const from = drag;
            drag = null;
            clearDropMarks();
            actions.move(node, from, index - from);
        });
        el.addEventListener("contextmenu", (event) => openMenu(event, [
            ["Edit image…", () => actions.edit(node, index)],
            ["Duplicate image", () => actions.duplicate(node, index)],
            ["Copy image to clipboard", () => actions.copyOriginal(node, index)],
            ["Replace image…", () => actions.replace(node, index)],
            ["Remove image", () => actions.remove(node, index)],
        ]));
        return el;
    };

    const videoCardFor = (entry) => {
        const el = document.createElement("div");
        el.className = "card";
        el.title = "Click to capture frames";
        if (entry.poster) {
            const canvas = document.createElement("canvas");
            canvas.className = "thumb";
            canvas.addEventListener("click", () => actions.openVideo(node, entry));
            el.appendChild(canvas);
            paintSoon(() => paintThumb(canvas, (ctx, rect) => actions.drawThumb(ctx, entry.poster, null, rect)));
        } else {
            const text = document.createElement("div");
            text.className = `text${entry.failed ? " failed" : ""}`;
            text.textContent = entry.failed ? "Cannot decode here" : "🎞 video";
            text.addEventListener("click", () => actions.openVideo(node, entry));
            el.appendChild(text);
        }
        const label = document.createElement("div");
        label.className = "label";
        label.textContent = `${entry.duration ? formatTime(entry.duration) + " · " : ""}${entry.name || entry.filename || "video"}`;
        const remove = button("×", "Remove the video (captured frames stay)", () => actions.removeVideo(node, entry));
        remove.className = "btn remove";
        el.append(label, remove);
        return el;
    };

    let pending = false;
    const render = () => {
        if (!view.alive) return;
        pending = false;
        const items = actions.items(node);
        const videos = actions.videos(node);
        status.textContent = actions.status(node);
        buttons.undo.disabled = !actions.canUndo(node);
        buttons.redo.disabled = !actions.canRedo(node);
        buttons.clear.disabled = !items.length && !videos.length;
        buttons.copy.disabled = !items.length;
        buttons.preview.disabled = !items.length;
        const previewOn = actions.previewOn(node) && items.length > 0;
        buttons.preview.textContent = previewOn ? "Preview ✓" : "Preview";
        buttons.preview.className = previewOn ? "on" : "";
        const optionsOn = actions.optionsOn(node);
        const extra = actions.optionsCount(node);
        buttons.options.textContent = `Options ${optionsOn ? "▾" : "▸"}${!optionsOn && extra ? ` (${extra})` : ""}`;
        buttons.options.className = optionsOn ? "on" : "";
        const sizeOn = actions.sizePanelOn(node);
        buttons.size.textContent = sizeOn ? "📐 Size ✓" : "📐 Size";
        buttons.size.className = sizeOn ? "on" : "";

        preview.hidden = !previewOn;
        if (previewOn) {
            paintSoon(() => paintThumb(preview, (ctx, rect) => actions.drawPreview(ctx, node, rect)));
        }
        if (typeof cards.replaceChildren === "function") cards.replaceChildren();
        else cards.innerHTML = "";
        items.forEach((item, index) => cards.appendChild(cardFor(item, index)));
        videos.forEach((entry) => cards.appendChild(videoCardFor(entry)));
        const columns = columnsForWidth(node?.size?.[0]);
        if (cards.style) cards.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
        cards.hidden = !items.length && !videos.length;
        empty.hidden = items.length > 0 || videos.length > 0;
        panel.hidden = !sizeOn;
        if (sizeOn) paintSoon(() => paintThumb(panel, (ctx, rect) => actions.drawSizePanel(ctx, node, rect)));

        const height = measuredHeight(root) ?? viewHeight(node, actions);
        if (height !== view.height) {
            view.height = height;
            actions.resized?.(node, height);
        }
        // Thumbnails and posters arrive asynchronously; keep refreshing while
        // any is still on its way.
        const waiting = items.some((item) => { const s = actions.thumb(node, item); return !s.ready && !s.failed; })
            || videos.some((entry) => !entry.poster && !entry.failed);
        if (waiting && !pending) {
            pending = true;
            view.timer = setTimeout(render, REFRESH_MS);
        }
    };
    view.render = render;
    view.refresh = () => {
        if (!view.alive) return;
        clearTimeout(view.timer);
        view.timer = setTimeout(render, 0);
    };

    view.widget = node.addDOMWidget(DOM_VIEW_WIDGET, "MULTI_STITCH_VIEW", root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => view.height || viewHeight(node, actions),
        getHeight: () => view.height || viewHeight(node, actions),
        getValue: () => undefined,
        setValue: () => {},
    });
    if (view.widget) {
        // The frontend reads this flag on the widget itself, not in options.
        view.widget.serialize = false;
        view.widget.computeLayoutSize = () => {
            const height = view.height || viewHeight(node, actions);
            return { minHeight: height, maxHeight: height, minWidth: 420 };
        };
        view.widget.serializeValue = () => undefined;
    }
    if (typeof ResizeObserver === "function") {
        view.observer = new ResizeObserver(() => {
            if (!view.alive) return;
            const height = measuredHeight(root);
            if (height && height !== view.height) {
                view.height = height;
                actions.resized?.(node, height);
            }
        });
        try {
            view.observer.observe(root);
        } catch (_) {
            view.observer = null;
        }
    }

    view.destroy = () => {
        view.alive = false;
        view.observer?.disconnect?.();
        view.observer = null;
        closeMenu();
        clearTimeout(view.timer);
        const widget = view.widget;
        if (widget) {
            if (typeof node.removeWidget === "function") node.removeWidget(widget);
            else if (Array.isArray(node.widgets)) {
                const index = node.widgets.indexOf(widget);
                if (index >= 0) node.widgets.splice(index, 1);
            }
            widget.onRemove?.();
        }
        root.remove?.();
        if (node._msDomView === view) node._msDomView = null;
    };
    render();
    return view;
}

export function removeDomView(node) {
    node?._msDomView?.destroy?.();
}

export function refreshDomView(node) {
    node?._msDomView?.refresh?.();
}
