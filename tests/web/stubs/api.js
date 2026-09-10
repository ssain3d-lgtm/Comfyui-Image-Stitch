// Stand-in for ComfyUI's scripts/api.js.
//
// /upload/image succeeds after `knobs.delayMs` and honours AbortSignal, so
// tests can cancel or clear mid-upload. /view URLs point at the real ComfyUI
// origin unless `globalThis.__msFixtureBase` is set, in which case they map to
// `<base>/<filename>` so a static fixture server can serve them.
export const uploads = [];
export const knobs = { delayMs: 0, failNext: false };

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
        if (path !== "/upload/image") {
            return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
        }
        if (knobs.failNext) {
            knobs.failNext = false;
            return { ok: false, status: 500, statusText: "Upload exploded", json: async () => ({}) };
        }
        const name = options.body?.entries?.().next?.().value?.[2] || options.body?._name || "upload.png";
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
        return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ name, subfolder: "multi_stitch", type: "input" }),
        };
    },
};
