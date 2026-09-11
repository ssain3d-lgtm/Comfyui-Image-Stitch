"""The browser code re-implements three pieces of backend maths so the node can
preview its result. These tests run the real JavaScript under Node and compare
it with the Python implementation case by case, so the two cannot drift.
"""
import importlib.util
import json
import random
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

folder_paths = types.ModuleType("folder_paths")
folder_paths.get_input_directory = lambda: "."
folder_paths.get_temp_directory = lambda: "."
sys.modules.setdefault("folder_paths", folder_paths)

spec = importlib.util.spec_from_file_location("multi_stitch_parity", REPO / "multi_stitch.py")
ms = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(ms)

NODE = shutil.which("node")

RUNNER = """
import {
    normalizeCrop, gridShape, cropSourceToView, cropViewToSource, layoutPlacements, limitedSize, cropPixelBox,
} from "./pkg/web/shared.js";
import { readFileSync } from "node:fs";
const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = {
    crops: (cases.crops || []).map((c) => normalizeCrop(c)),
    grid: (cases.grid || []).map(([n, gc, d]) => gridShape(n, gc, d)),
    forward: (cases.mapping || []).map(([c, t]) => cropSourceToView(c, t)),
    roundtrip: (cases.mapping || []).map(([c, t]) => cropViewToSource(cropSourceToView(c, t), t)),
    layout: (cases.layout || []).map(([dims, layout, direction, match, gc, sw, cw, ch, ref]) =>
        layoutPlacements(dims.map(([w, h]) => ({ w, h })), layout, direction, match, gc, sw, cw, ch, ref)),
    limit: (cases.limit || []).map(([w, h, mode, px]) => limitedSize(w, h, mode, px)),
    box: (cases.box || []).map(([w, h, c]) => cropPixelBox(w, h, c)),
};
process.stdout.write(JSON.stringify(out));
"""


def rotate_crop(crop, rotation):
    # Reference implementation of the crop mapping, checked elsewhere against
    # the real Pillow pipeline (every transform selects identical source pixels).
    x, y, w, h = crop
    if rotation == 90:
        return (1 - y - h, x, h, w)
    if rotation == 180:
        return (1 - x - w, 1 - y - h, w, h)
    if rotation == 270:
        return (y, 1 - x - w, h, w)
    return (x, y, w, h)


def source_to_view(crop, transform):
    rotation, flip_h, flip_v = transform
    out = rotate_crop(crop, rotation)
    if flip_h:
        out = (1 - out[0] - out[2], out[1], out[2], out[3])
    if flip_v:
        out = (out[0], 1 - out[1] - out[3], out[2], out[3])
    return out


@unittest.skipUnless(NODE, "node is not installed")
class FrontendParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        (root / "scripts").mkdir()
        (root / "scripts" / "api.js").write_text("export const api = {};\n", encoding="utf-8")
        shutil.copytree(REPO / "web", root / "pkg" / "web")
        (root / "runner.mjs").write_text(RUNNER, encoding="utf-8")
        cls.root = root

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def run_js(self, cases):
        path = self.root / "cases.json"
        path.write_text(json.dumps(cases), encoding="utf-8")
        result = subprocess.run(
            [NODE, str(self.root / "runner.mjs"), str(path)],
            capture_output=True, text=True, check=True, cwd=self.root,
        )
        return json.loads(result.stdout)

    def assertClose(self, got, want, places=9):
        for key, value in want.items():
            self.assertAlmostEqual(got[key], value, places=places, msg=f"{key}: {got} != {want}")

    def test_javascript_matches_python(self):
        crops = [
            None, {}, {"x": 1, "y": 0, "w": 0.5, "h": 0.5}, {"x": 0, "y": 1, "w": 0.5, "h": 0.5},
            {"x": 0.999999, "y": 0, "w": 1, "h": 1}, {"x": -5, "y": -5, "w": 2, "h": 2},
            {"x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5}, {"x": 0.5, "y": 0.5, "w": 0.9, "h": 0.9},
            {"x": "abc", "y": 0, "w": 1, "h": 1}, {"x": 0, "y": 0, "w": 0, "h": 1},
            {"x": 0, "y": 0, "w": 1, "h": 0}, {"x": 0.3, "y": 0.3, "w": 0.0000001, "h": 0.5},
            {"x": float("nan"), "y": 0.2, "w": 0.3, "h": 0.4},
        ]
        grid = [(n, gc, d) for d in ms._DIRECTIONS for n in range(1, 25) for gc in range(1, 17)]
        transforms = [(r, fh, fv) for r in (0, 90, 180, 270) for fh in (False, True) for fv in (False, True)]
        rects = [(0, 0, 1, 1), (0.1, 0.2, 0.3, 0.4), (0.5, 0.5, 0.5, 0.5), (0, 0.25, 1, 0.5),
                 (0.75, 0, 0.25, 1), (0.33, 0.11, 0.22, 0.44)]
        mapping = [(c, t) for t in transforms for c in rects]

        def js_crop(c):
            return None if c is None else {k: (None if isinstance(v, float) and v != v else v) for k, v in c.items()}

        got = self.run_js({
            "crops": [js_crop(c) for c in crops],
            "grid": grid,
            "mapping": [
                ({"x": c[0], "y": c[1], "w": c[2], "h": c[3]},
                 {"rotation": t[0], "flip_h": t[1], "flip_v": t[2]})
                for c, t in mapping
            ],
        })

        for case, js in zip(crops, got["crops"]):
            with self.subTest(normalizeCrop=case):
                self.assertClose(js, dict(zip("xywh", ms._normalize_crop(case))))

        for (n, gc, d), js in zip(grid, got["grid"]):
            rows, cols = ms._grid_shape(n, gc, d)
            with self.subTest(gridShape=(n, gc, d)):
                self.assertEqual((js["rows"], js["cols"]), (rows, cols))

        for (c, t), js, back in zip(mapping, got["forward"], got["roundtrip"]):
            with self.subTest(cropSourceToView=(c, t)):
                self.assertClose(js, dict(zip("xywh", source_to_view(c, t))))
                self.assertClose(back, dict(zip("xywh", c)))

    def test_layout_and_output_limit_match_python(self):
        """Placement rects and the output cap are compared exactly, pixel for pixel."""
        rng = random.Random(4242)
        layout_cases = []
        for _ in range(600):
            count = rng.randint(1, 8)
            dims = [(rng.randint(1, 60), rng.randint(1, 60)) for _ in range(count)]
            layout_cases.append([
                dims, rng.choice(ms._LAYOUT_MODES), rng.choice(ms._DIRECTIONS), rng.choice([True, False]),
                rng.randint(1, 6), rng.choice([0, 1, 3, 7]), *rng.choice([(0, 0), (25, 15), (40, 40), (7, 0)]),
                rng.choice(ms._MATCH_REFERENCES),
            ])
        # Include sizes that hit exact .5 after scaling, where half-even rounding matters.
        layout_cases.append([[(4, 1), (5, 2)], "strip", "right", True, 3, 0, 0, 0, "first"])
        layout_cases.append([[(1, 4), (2, 5)], "strip", "down", True, 3, 0, 0, 0, "first"])
        layout_cases.append([[(5, 2), (4, 1)], "strip", "right", True, 3, 0, 0, 0, "smallest"])
        # Ties: equal heights, equal areas — the earlier image must win on both sides.
        layout_cases.append([[(10, 10), (20, 10), (5, 10)], "strip", "right", True, 3, 0, 0, 0, "largest"])
        layout_cases.append([[(10, 60), (90, 5), (30, 20), (60, 10)], "grid", "down", True, 2, 1, 0, 0, "largest"])
        layout_cases.append([[(6, 6), (9, 4), (4, 9)], "grid", "up", True, 2, 0, 0, 0, "smallest"])
        limit_cases = [
            [w, h, mode, px]
            for w, h in ((400, 200), (1, 1), (5000, 3), (777, 777), (2048, 1024))
            for mode in ms._OUTPUT_LIMITS
            for px in (64, 100, 777, 2048, 16384)
        ]

        got = self.run_js({"layout": layout_cases, "limit": limit_cases})

        for case, js in zip(layout_cases, got["layout"]):
            dims, layout, direction, match, columns, spacing, cell_w, cell_h, reference = case
            width, height, placements = ms._layout(
                dims, layout, direction, match, columns, spacing, cell_w, cell_h, match_reference=reference,
            )
            with self.subTest(layout=case):
                self.assertEqual((js["width"], js["height"]), (width, height))
                self.assertEqual(
                    [(p["x"], p["y"], p["w"], p["h"]) for p in js["placements"]],
                    [tuple(p) for p in placements],
                )
        for (w, h, mode, px), js in zip(limit_cases, got["limit"]):
            with self.subTest(limit=(w, h, mode, px)):
                self.assertEqual((js["w"], js["h"]), ms._limited_size(w, h, mode, px))

    def test_crop_pixel_box_matches_python(self):
        """cropPixelBox mirrors _crop_box, half-even rounding and 1px minimum included."""
        rng = random.Random(99)
        cases = []
        for _ in range(500):
            width, height = rng.randint(1, 60), rng.randint(1, 60)
            x, y = rng.random(), rng.random()
            cases.append([width, height, {"x": x, "y": y, "w": rng.random() * (1 - x), "h": rng.random() * (1 - y)}])
        cases += [[10, 10, {"x": 0.15, "y": 0.15, "w": 0.3, "h": 0.3}], [1, 1, {"x": 0, "y": 0, "w": 1, "h": 1}],
                  [7, 3, {"x": 0.5, "y": 0.5, "w": 0.5, "h": 0.5}], [40, 20, {"x": 0.999, "y": 0.999, "w": 0.001, "h": 0.001}]]
        got = self.run_js({"box": cases})
        for (width, height, crop), js in zip(cases, got["box"]):
            left, top, right, bottom = ms._crop_box(width, height, crop)
            with self.subTest(box=(width, height, crop)):
                self.assertEqual((js["x"], js["y"], js["w"], js["h"]), (left, top, right - left, bottom - top))


if __name__ == "__main__":
    unittest.main()
