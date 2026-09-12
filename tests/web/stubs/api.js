// Stand-in for ComfyUI's scripts/api.js.
//
// /upload/image succeeds after `knobs.delayMs` and honours AbortSignal, so
// tests can cancel or clear mid-upload. /view URLs point at the real ComfyUI
// origin unless `globalThis.__msFixtureBase` is set, in which case they map to
// `<base>/<filename>` so a static fixture server can serve them.
export const uploads = [];
// One {type, subfolder} per upload, in order — where the file went.
export const uploadTargets = [];
// Every fetchApi call, in order: {path, options}.
export const calls = [];
// `serverVideo` false makes the PyAV routes answer 501, as a server without
// PyAV would; `serverVideoInfo` is what /multi_stitch/video/info returns.
export const knobs = { delayMs: 0, failNext: false, serverVideo: true, serverVideoInfo: { duration: 2, fps: 10, width: 320, height: 180, frames: 20, rotation: 0 } };
let serverCaptures = 0;

export const api = {
    apiURL(path) {
        const base = globalThis.__msFixtureBase;
        const query = path.indexOf("?");
        if (base && path.startsWith("/view") && query >= 0) {
            const name = new URLSearchParams(path.slice(query + 1)).get("filename");
            return `${base}/${name}`;
        }
        return `http://127.0.0.1:8188${path}`;
    },
    async fetchApi(path, options = {}) {
        calls.push({ path, options });
        if (path.startsWith("/multi_stitch/video/info")) {
            if (!knobs.serverVideo) {
                return { ok: false, status: 501, statusText: "Not Implemented", json: async () => ({ error: "PyAV is not installed; run: pip install av" }) };
            }
            return { ok: true, status: 200, statusText: "OK", json: async () => ({ ...knobs.serverVideoInfo }) };
        }
        if (path === "/multi_stitch/video/capture") {
            if (!knobs.serverVideo) {
                return { ok: false, status: 501, statusText: "Not Implemented", json: async () => ({ error: "PyAV is not installed; run: pip install av" }) };
            }
            const body = JSON.parse(options.body || "{}");
            serverCaptures += 1;
            const name = `multi_stitch_server_${serverCaptures}.png`;
            uploads.push(name);
            return {
                ok: true, status: 200, statusText: "OK",
                json: async () => ({
                    name, subfolder: "multi_stitch", type: "input",
                    width: knobs.serverVideoInfo.width, height: knobs.serverVideoInfo.height, time: body.time,
                }),
            };
        }
        if (path === "/multi_stitch/video/delete") {
            const body = JSON.parse(options.body || "{}");
            return {
                ok: true, status: 200, statusText: "OK",
                json: async () => ({ removed: body.filenames || [], missing: [], rejected: [] }),
            };
        }
        if (path !== "/upload/image") {
            return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
        }
        if (knobs.failNext) {
            knobs.failNext = false;
            return { ok: false, status: 500, statusText: "Upload exploded", json: async () => ({}) };
        }
        const fields = [...(options.body?.entries?.() || [])];
        const name = fields.find(([key]) => key === "image")?.[2] || options.body?._name || "upload.png";
        const target = {
            type: fields.find(([key]) => key === "type")?.[1] || "input",
            subfolder: fields.find(([key]) => key === "subfolder")?.[1] || "multi_stitch",
        };
        await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, knobs.delayMs);
            options.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                const error = new Error("The upload was cancelled.");
                error.name = "AbortError";
                reject(error);
            });
        });
        uploads.push(name);
        uploadTargets.push(target);
        return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ name, subfolder: target.subfolder, type: target.type }),
        };
    },
};
