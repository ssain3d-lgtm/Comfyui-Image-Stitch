// Runs the frontend coverage suite and enforces a floor on named files.
//
// The whole table cannot carry a threshold: the harness stages web/ into a
// fresh temp directory per test file, so every file appears once per run and
// the copies the other runners never import sit near zero. The crop editor
// also executes in Chromium, where Node's coverage cannot see it at all. So
// the gate reads the best row per named file — the run that actually exercises
// it — and leaves the rest reported.
import { spawnSync } from "node:child_process";

const FLOORS = { "shared.js": 85 };

const run = spawnSync("node", ["--test", "--experimental-test-coverage", "tests/web/*.test.mjs"], {
    encoding: "utf8", shell: true, env: process.env,
});
process.stdout.write(run.stdout || "");
process.stderr.write(run.stderr || "");
if (run.status !== 0) process.exit(run.status ?? 1);

// "# shared.js | 97.24 | 74.47 | 92.59 | 117 177-178"
const best = new Map();
for (const line of (run.stdout || "").split("\n")) {
    const cells = line.replace(/^#\s*/, "").split("|").map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const file = cells[0];
    const lines = Number(cells[1]);
    if (!(file in FLOORS) || !Number.isFinite(lines)) continue;
    best.set(file, Math.max(best.get(file) ?? 0, lines));
}

let failed = false;
for (const [file, floor] of Object.entries(FLOORS)) {
    const covered = best.get(file);
    if (covered === undefined) {
        console.error(`coverage gate: ${file} is not in the coverage table`);
        failed = true;
    } else if (covered < floor) {
        console.error(`coverage gate: ${file} at ${covered.toFixed(2)}% of lines, floor is ${floor}%`);
        failed = true;
    } else {
        console.log(`coverage gate: ${file} ${covered.toFixed(2)}% of lines (floor ${floor}%)`);
    }
}
process.exit(failed ? 1 : 0);
