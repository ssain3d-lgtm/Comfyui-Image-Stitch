// Gallery of compositions: everything this node type has stitched (recorded
// by the server on each run, or saved by hand), each with a preview, ready to
// load back into a node or append to it. The images already live in ComfyUI's
// input folder, so the gallery is also where that storage gets tidied.
import { api } from "../../scripts/api.js";

export const GALLERY_ROUTES = {
    list: "/multi_stitch/gallery",
    save: "/multi_stitch/gallery/save",
    rename: "/multi_stitch/gallery/rename",
    delete: "/multi_stitch/gallery/delete",
    cleanup: "/multi_stitch/gallery/cleanup",
    settings: "/multi_stitch/gallery/settings",
};
const PREVIEW_SUBFOLDER = "multi_stitch/gallery";

let stylesInstalled = false;
function installStyles() {
    if (stylesInstalled || typeof document === "undefined") return;
    stylesInstalled = true;
    const style = document.createElement("style");
    style.textContent = `
.ms-gallery-overlay{position:fixed;inset:0;z-index:10010;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;font:13px/1.35 sans-serif;color:#e6e6e6;outline:none}
.ms-gallery-panel{background:#202020;border:1px solid #3a3a3a;border-radius:8px;width:min(1040px,94vw);max-height:90vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.6)}
.ms-gallery-head{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid #333}
.ms-gallery-head .title{font-weight:600;font-size:14px}
.ms-gallery-head .storage{color:#9a9a9a;font-size:12px;flex:1;text-align:right}
.ms-gallery-head .close{background:none;border:0;color:#bbb;font-size:16px;cursor:pointer;padding:2px 6px}
.ms-gallery-head .close:hover{color:#fff}
.ms-gallery-tools{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid #2c2c2c;flex-wrap:wrap}
.ms-gallery-tools .spacer{flex:1}
.ms-gallery-tools label{color:#bdbdbd;display:flex;align-items:center;gap:6px;cursor:pointer}
.ms-gallery-overlay button{background:#3a3a3a;border:1px solid #4a4a4a;color:#eee;border-radius:4px;padding:4px 10px;cursor:pointer;font:inherit}
.ms-gallery-overlay button:hover{background:#474747}
.ms-gallery-overlay button:disabled{opacity:.5;cursor:default}
.ms-gallery-overlay button.primary{background:#2f6b45;border-color:#3f8b5a}
.ms-gallery-overlay button.primary:hover{background:#3a835a}
.ms-gallery-overlay button.danger{border-color:#7a3b3b}
.ms-gallery-overlay button.danger:hover{background:#5a2f2f}
.ms-gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;padding:12px 14px;overflow:auto;flex:1;min-height:160px}
.ms-gallery-card{background:#181818;border:1px solid #333;border-radius:6px;display:flex;flex-direction:column;overflow:hidden}
.ms-gallery-card .thumb{height:132px;background:#0e0e0e;display:flex;align-items:center;justify-content:center;color:#666;font-size:12px;overflow:hidden}
.ms-gallery-card .thumb img{max-width:100%;max-height:100%;object-fit:contain;display:block}
.ms-gallery-card .name{padding:6px 8px 0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:text}
.ms-gallery-card .name:hover{color:#fff;text-decoration:underline dotted}
.ms-gallery-card .meta{padding:2px 8px 6px;color:#9a9a9a;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ms-gallery-card .actions{display:flex;gap:6px;padding:0 8px 8px;flex-wrap:wrap}
.ms-gallery-card .actions button{padding:3px 8px;font-size:12px}
.ms-gallery-empty{grid-column:1/-1;color:#8f8f8f;text-align:center;padding:40px 12px;line-height:1.6}
.ms-gallery-status{padding:6px 14px 10px;color:#9a9a9a;font-size:12px;min-height:18px}
.ms-gallery-status.error{color:#f28b82}
`;
    document.head.appendChild(style);
}

const ask = (message, initial = "") => (typeof prompt === "function" ? prompt(message, initial) : initial);

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatWhen(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const d = new Date(seconds * 1000);
    const pad = (v) => String(v).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function previewUrl(entry) {
    if (!entry?.preview) return null;
    const params = new URLSearchParams({ filename: `${entry.id}.jpg`, subfolder: PREVIEW_SUBFOLDER, type: "input" });
    // The preview is rewritten when an entry is re-recorded without one; the
    // timestamp keeps the browser from showing a stale cached copy.
    params.set("t", String(Math.round(entry.used || entry.created || 0)));
    return api.apiURL(`/view?${params.toString()}`);
}

export function entryMeta(entry) {
    const count = entry.images?.length || 0;
    const parts = [`${count} image${count === 1 ? "" : "s"}${entry.input_frames ? ` + ${entry.input_frames} from IMAGE` : ""}`];
    if (entry.width && entry.height) parts.push(`${entry.width}×${entry.height}`);
    if (entry.uses > 1) parts.push(`used ${entry.uses}×`);
    const when = formatWhen(entry.used || entry.created);
    if (when) parts.push(when);
    return parts.join(" · ");
}

export function storageText(storage) {
    if (!storage) return "";
    const base = `${storage.files} file${storage.files === 1 ? "" : "s"} · ${formatBytes(storage.bytes)} in input/multi_stitch`;
    return storage.unreferenced_files
        ? `${base} · ${storage.unreferenced_files} not in any entry (${formatBytes(storage.unreferenced_bytes)})`
        : base;
}

async function request(route, init) {
    const response = await api.fetchApi(route, init);
    let data;
    try {
        data = await response.json();
    } catch {
        // A route that answered with something other than JSON (a proxy error
        // page, say) still has to produce a readable message below.
        data = null;
    }
    if (!response.ok) {
        throw new Error(data?.error || `${route} answered ${response.status}`);
    }
    return data;
}

function postJson(route, body) {
    return request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// Opens the gallery for a node. Hooks:
//   load(entry)    → replace the node's images and settings with the entry's
//   append(entry)  → add the entry's images after the current ones
//   current()      → { images, settings, size } to save by hand, or null
//   keep()         → file names the open workflow uses (never deleted by cleanup)
//   onClose()      → the overlay is gone
// Returns handles the caller (and the tests) can drive.
export function openGallery(node, hooks = {}) {
    installStyles();
    const overlay = document.createElement("div");
    overlay.className = "ms-gallery-overlay";
    overlay.tabIndex = -1;
    overlay.innerHTML = `
      <div class="ms-gallery-panel" role="dialog" aria-modal="true" aria-label="Gallery">
        <div class="ms-gallery-head">
          <span class="title">🖼 Gallery — stitched compositions</span>
          <span class="storage"></span>
          <button class="close" title="Close (Esc)">✕</button>
        </div>
        <div class="ms-gallery-tools">
          <button class="primary save" title="Save this node's images and settings as an entry">＋ Save current</button>
          <label title="Record every composition this node type stitches, once per distinct one"><input type="checkbox" class="autosave"> save every run</label>
          <span class="spacer"></span>
          <button class="cleanup" title="Delete stored images that no gallery entry and no open node uses">Clean up unused files…</button>
        </div>
        <div class="ms-gallery-grid"></div>
        <div class="ms-gallery-status"></div>
      </div>`;
    if (typeof overlay.querySelector !== "function") throw new Error("The gallery needs a browser DOM.");
    document.body.appendChild(overlay);

    const grid = overlay.querySelector(".ms-gallery-grid");
    const status = overlay.querySelector(".ms-gallery-status");
    const storageEl = overlay.querySelector(".ms-gallery-head .storage");
    const autosaveBox = overlay.querySelector(".autosave");
    const state = { entries: [], storage: null, settings: { autosave: true }, busy: false, closed: false };

    const say = (text, isError = false) => {
        status.textContent = text || "";
        status.className = `ms-gallery-status${isError ? " error" : ""}`;
    };

    const close = () => {
        if (state.closed) return;
        state.closed = true;
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        hooks.onClose?.();
    };

    // Keys are handled here and stopped: the canvas underneath must not see
    // Delete (it removes the node), Space (pan) or Ctrl+Z (graph reload).
    const onKey = (event) => {
        if (state.closed) return;
        const editing = event.target && /^(INPUT|TEXTAREA)$/.test(event.target.tagName);
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (editing) event.target.blur?.();
            else close();
            return;
        }
        if (!editing && (event.key === "Delete" || event.key === "Backspace" || event.key === " " || ((event.ctrlKey || event.metaKey) && /^[zy]$/i.test(event.key)))) {
            event.preventDefault();
            event.stopPropagation();
        }
    };
    document.addEventListener("keydown", onKey, true);

    const card = (entry) => {
        const el = document.createElement("div");
        el.className = "ms-gallery-card";
        el.setAttribute("data-id", entry.id);
        const url = previewUrl(entry);
        el.innerHTML = `
          <div class="thumb">${url ? `<img alt="" loading="lazy" src="${escapeHtml(url)}">` : "no preview"}</div>
          <div class="name" title="Click to rename">${escapeHtml(entry.name || entry.id)}</div>
          <div class="meta">${escapeHtml(entryMeta(entry))}</div>
          <div class="actions">
            <button class="primary load" title="Replace this node's images and settings with this entry">Load</button>
            <button class="append" title="Add this entry's images after the current ones">Add</button>
            <button class="danger delete" title="Remove the entry (its image files stay)">Delete</button>
            <button class="danger delete-files" title="Remove the entry and delete its image files that no other entry or open node uses">Delete + files</button>
          </div>`;
        el.querySelector(".load")?.addEventListener("click", () => run(async () => {
            await hooks.load?.(entry);
            say(`Loaded "${entry.name || entry.id}".`);
            close();
        }));
        el.querySelector(".append")?.addEventListener("click", () => run(async () => {
            await hooks.append?.(entry);
            say(`Added the images of "${entry.name || entry.id}".`);
        }));
        el.querySelector(".delete")?.addEventListener("click", () => run(async () => {
            if (!confirm(`Delete the gallery entry "${entry.name || entry.id}"?\nIts image files stay in input/multi_stitch.`)) return;
            const result = await postJson(GALLERY_ROUTES.delete, { ids: [entry.id], files: false, keep: hooks.keep?.() || [] });
            say(`Entry removed.`);
            await refresh(result.storage);
        }));
        el.querySelector(".delete-files")?.addEventListener("click", () => run(async () => {
            if (!confirm(
                `Delete the gallery entry "${entry.name || entry.id}" AND its image files that no other entry or open node uses?\n` +
                "Workflows saved on disk that reference those files cannot be detected. This cannot be undone.",
            )) return;
            const result = await postJson(GALLERY_ROUTES.delete, { ids: [entry.id], files: true, keep: hooks.keep?.() || [] });
            say(`Entry removed; ${result.files_removed} file${result.files_removed === 1 ? "" : "s"} deleted (${formatBytes(result.bytes_freed)}).`);
            await refresh(result.storage);
        }));
        el.querySelector(".name")?.addEventListener("click", () => run(async () => {
            const name = ask("Name for this entry:", entry.name || "");
            if (name == null || name.trim() === "" || name === entry.name) return;
            const result = await postJson(GALLERY_ROUTES.rename, { id: entry.id, name });
            entry.name = result.entry?.name ?? name;
            render();
        }));
        return el;
    };

    const render = () => {
        if (typeof grid.replaceChildren === "function") grid.replaceChildren();
        else {
            grid.innerHTML = "";
            if (Array.isArray(grid.children)) grid.children.length = 0;
        }
        if (!state.entries.length) {
            const empty = document.createElement("div");
            empty.className = "ms-gallery-empty";
            empty.textContent = "Nothing here yet. Every composition this node stitches is recorded on its first run; or press Save current.";
            grid.appendChild(empty);
        } else {
            for (const entry of state.entries) grid.appendChild(card(entry));
        }
        storageEl.textContent = storageText(state.storage);
        if (autosaveBox) autosaveBox.checked = state.settings.autosave !== false;
    };

    const run = async (task) => {
        if (state.busy) return;
        state.busy = true;
        try {
            await task();
        } catch (error) {
            say(error?.message || String(error), true);
        } finally {
            state.busy = false;
        }
    };

    const refresh = async (storage) => {
        if (state.closed) return;
        const data = await request(GALLERY_ROUTES.list);
        state.entries = Array.isArray(data?.entries) ? data.entries : [];
        state.storage = storage || data?.storage || null;
        if (data?.settings) state.settings = data.settings;
        render();
    };

    overlay.querySelector(".close")?.addEventListener("click", close);
    overlay.addEventListener("mousedown", (event) => {
        if (event.target === overlay) close();
    });
    overlay.querySelector(".save")?.addEventListener("click", () => run(async () => {
        const current = hooks.current?.();
        if (!current?.images?.length) {
            say("Add images to the node first.", true);
            return;
        }
        const name = ask("Name for this entry (optional):", "");
        if (name === null) return;
        say("Saving…");
        const result = await postJson(GALLERY_ROUTES.save, { ...current, name: name.trim() || undefined });
        say(`Saved "${result.entry?.name || "entry"}".`);
        await refresh(result.storage);
    }));
    autosaveBox?.addEventListener("change", () => run(async () => {
        const autosave = !!autosaveBox.checked;
        const result = await postJson(GALLERY_ROUTES.settings, { autosave });
        state.settings = result?.settings || { autosave };
        say(autosave ? "Every distinct composition will be recorded when it is stitched." : "New runs will not be recorded; Save current still works.");
    }));
    overlay.querySelector(".cleanup")?.addEventListener("click", () => run(async () => {
        const storage = state.storage;
        if (!storage?.unreferenced_files) {
            say("Every stored image is referenced by a gallery entry.");
            return;
        }
        if (!confirm(
            `Delete ${storage.unreferenced_files} stored image${storage.unreferenced_files === 1 ? "" : "s"} (${formatBytes(storage.unreferenced_bytes)}) ` +
            "that no gallery entry and no open node uses?\nWorkflows saved on disk that reference them cannot be detected. This cannot be undone.",
        )) return;
        const result = await postJson(GALLERY_ROUTES.cleanup, { keep: hooks.keep?.() || [] });
        say(`${result.files_removed} file${result.files_removed === 1 ? "" : "s"} deleted (${formatBytes(result.bytes_freed)}).`);
        await refresh(result.storage);
    }));

    say("Loading…");
    refresh().then(() => say(""), (error) => say(error?.message || String(error), true));
    overlay.focus?.();
    return { overlay, state, refresh, close, onKey };
}
