// What the IMAGE inputs bring, shown on the node before and after a run.
//
// A picture on an IMAGE input only exists once the nodes above it have run —
// a Crop Head has to find the face before there is anything to show — with
// one exception: a Load Image hands over a file that is already on the
// server, so it can be shown the moment it is connected. Everything else is
// shown from the frames the last run actually received (the backend writes
// them to the temp folder and names them in its "multi_stitch_inputs" UI
// output), and as a placeholder until there has been one.
import { defaultCrop, forgetThumb, imageInputNumber, loadTransformedThumb } from "./shared.js";

// The nodes whose "image" widget is a file the IMAGE output is read from.
const FILE_LOADERS = new Set(["LoadImage", "LoadImageOutput"]);

// "sub/dir/name.png [output]" → the file it names, as an item the thumbnail
// loader and the preview understand. The annotation is how ComfyUI marks a
// file outside the input folder.
export function loadImageItem(value) {
    if (typeof value !== "string") return null;
    const match = /^(.*?)(?:\s*\[(input|output|temp)\])?$/.exec(value.trim());
    const path = match?.[1]?.replace(/\\/g, "/") || "";
    if (!path || path.endsWith("/")) return null;
    const cut = path.lastIndexOf("/");
    return {
        filename: path.slice(cut + 1),
        subfolder: cut >= 0 ? path.slice(0, cut) : "",
        type: match[2] || "input",
        crop: defaultCrop(),
    };
}

function graphLink(graph, id) {
    if (!graph || id == null) return null;
    return graph.getLink?.(id) ?? graph.links?.get?.(id) ?? graph.links?.[id] ?? null;
}

// The node and output a link really starts from, walking back through the
// classic Reroute nodes; the newer link reroutes keep the real origin anyway.
export function linkOrigin(node, linkId) {
    const graph = node?.graph;
    let link = graphLink(graph, linkId);
    for (let hops = 0; link && hops < 32; hops++) {
        const origin = graph.getNodeById?.(link.origin_id);
        if (!origin) return null;
        if (origin.type === "Reroute") {
            link = graphLink(graph, origin.inputs?.[0]?.link);
            continue;
        }
        return { node: origin, slot: link.origin_slot, key: `${origin.id}:${link.origin_slot}` };
    }
    return null;
}

function fileFrom(origin) {
    const loader = origin?.node;
    if (!loader || origin.slot !== 0) return null;
    if (!FILE_LOADERS.has(loader.comfyClass) && !FILE_LOADERS.has(loader.type)) return null;
    const widget = (loader.widgets || []).find((w) => w?.name === "image");
    return loadImageItem(widget?.value);
}

// What feeds a socket, as a key a later look can compare: the node and output
// when they can be found, else the link itself — a subgraph's own input has
// no node to find.
function sourceKey(origin, input) {
    return origin?.key ?? `link:${input.link}`;
}

// The connected IMAGE inputs in the order the backend stitches them.
function connectedInputs(node) {
    return (node?.inputs || [])
        .map((input) => ({ input, number: imageInputNumber(input?.name) }))
        .filter(({ input, number }) => number && input.link != null)
        .sort((a, b) => a.number - b.number);
}

// One card per picture the inputs will bring, in stitch order:
//   { socket, number, item, source: "file" | "run" }  — something to show;
//   { socket, number, item: null, source: "pending" } — only a run will tell.
// A card from the last run is kept only while its socket is still fed by the
// same output it was fed by then, and while its file still loads.
export function inputCards(node) {
    const run = node?._msRunInputs;
    const cards = [];
    for (const { input, number } of connectedInputs(node)) {
        const socket = input.name;
        const origin = linkOrigin(node, input.link);
        const key = sourceKey(origin, input);
        // A file the browser cannot show (a format only the server reads, one
        // that moved) falls back to what the last run saw, like any other node.
        const file = fileFrom(origin);
        if (file && !loadTransformedThumb(node, file).failed) {
            cards.push({ socket, number, item: file, source: "file" });
            continue;
        }
        const frames = run?.origins?.[socket] === key ? run.frames[socket] : null;
        const usable = (frames || []).filter((item) => !loadTransformedThumb(node, item).failed);
        if (usable.length) {
            for (const item of usable) cards.push({ socket, number, item, source: "run" });
        } else {
            cards.push({ socket, number, item: null, source: "pending" });
        }
    }
    return cards;
}

// The frames past the ones the last run wrote out, while its cards still show.
export function inputFramesNotShown(node) {
    const run = node?._msRunInputs;
    if (!run?.more) return 0;
    return inputCards(node).some((card) => card.source === "run") ? run.more : 0;
}

// Takes the "multi_stitch_inputs" list a run sent back. The links are read
// now, which is when the run that produced it has just finished.
export function receiveInputPreviews(node, list) {
    if (!node || !Array.isArray(list)) return false;
    const frames = {};
    let more = 0;
    for (const entry of list) {
        if (!entry || typeof entry.filename !== "string" || typeof entry.socket !== "string") continue;
        const width = Number(entry.width);
        const height = Number(entry.height);
        (frames[entry.socket] ||= []).push({
            filename: entry.filename,
            subfolder: typeof entry.subfolder === "string" ? entry.subfolder : "",
            type: typeof entry.type === "string" ? entry.type : "temp",
            crop: defaultCrop(),
            // A large frame is written smaller; this is the size it really has.
            ...(width > 0 && height > 0 ? { size: [Math.round(width), Math.round(height)] } : {}),
        });
        if (Number(entry.more) > 0) more = Number(entry.more);
    }
    const origins = {};
    for (const { input } of connectedInputs(node)) {
        origins[input.name] = sourceKey(linkOrigin(node, input.link), input);
    }
    // The last run's files are not coming back — unless this is the same run
    // replayed from ComfyUI's cache, whose pixels are worth keeping.
    const kept = Object.values(frames).flat();
    const previous = Object.values(node._msRunInputs?.frames || {}).flat();
    for (const item of previous) forgetThumb(node, item, kept);
    node._msRunInputs = { frames, origins, more };
    return true;
}

// Changes whenever what the input cards show would: the Vue view compares it
// to know when to draw them again.
export function inputSignature(node) {
    return JSON.stringify(inputCards(node).map((card) => [
        card.socket, card.source, card.item ? `${card.item.type}:${card.item.subfolder}/${card.item.filename}` : "",
        card.item ? loadTransformedThumb(node, card.item).ready === true : false,
    ]));
}

// What a card says about where its picture comes from.
export function inputCardHint(card) {
    const from = card.source === "file"
        ? "from Load Image, live"
        : card.source === "run"
            ? "as of the last run · ▶ Inputs runs what feeds it again"
            : "click to run only the nodes feeding it";
    return `${card.socket} · ${from}`;
}
