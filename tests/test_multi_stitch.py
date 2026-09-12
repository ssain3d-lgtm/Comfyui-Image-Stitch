import importlib
import importlib.util
import inspect
import json
import os
import random
import re
import sys
import tempfile
import types
import unittest
import weakref
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch
from PIL import Image, ImageFile, ImageOps


# ComfyUI supplies folder_paths at runtime. CI intentionally tests this custom
# node without installing all of ComfyUI, so stub only the host module first.
folder_paths = types.ModuleType("folder_paths")
folder_paths.get_input_directory = lambda: "."
folder_paths.get_temp_directory = lambda: "."
sys.modules["folder_paths"] = folder_paths

MODULE_PATH = Path(__file__).resolve().parents[1] / "multi_stitch.py"
spec = importlib.util.spec_from_file_location("multi_stitch_under_test", MODULE_PATH)
ms = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(ms)


CI = bool(os.environ.get("CI"))


def requires(available: bool, reason: str):
    """Gate a TestCase class on an optional tool: skipped here, failed in CI.

    Node, PyAV and aiohttp are all installed by the workflow, so a skip in CI
    would quietly hide a broken environment instead of reporting it.
    """
    if available:
        return lambda case: case
    if not CI:
        return unittest.skip(reason)

    def replace(case):
        def test_the_optional_dependency_is_installed(self):
            self.fail(f"{reason}; CI must install it")

        return type(case.__name__, (unittest.TestCase,), {
            "test_the_optional_dependency_is_installed": test_the_optional_dependency_is_installed,
        })

    return replace


def load_the_whole_image_first(item, background=(1.0, 1.0, 1.0)):
    """_load_image as it ran before the crop was moved in front of the
    transforms: orient, flatten, rotate and flip the whole image, crop last.
    The new order has to select exactly the same pixels.
    """
    path = ms._safe_input_path(item)
    with ms._open_image(path) as source:
        image = source
        for method in ms._orientation_methods(ms._exif_orientation(source)):
            image = image.transpose(method)
        image = ms._flatten_alpha(image, background)
        image = ms._apply_transform(image, item)
        width, height = image.size
        box = ms._crop_box(width, height, item.get("crop"))
        if box != (0, 0, width, height):
            image = image.crop(box)
        array = np.asarray(image, dtype=np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0)


def solid(rgb, h=2, w=2):
    image = torch.zeros((1, h, w, 3), dtype=torch.float32)
    image[:] = torch.tensor(rgb, dtype=torch.float32)
    return image


class MultiStitchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.temp_dir = self.root / "temp"
        self.temp_dir.mkdir()
        ms.folder_paths.get_input_directory = lambda: str(self.root)
        ms.folder_paths.get_temp_directory = lambda: str(self.temp_dir)

    def tearDown(self):
        self.temp.cleanup()

    def assertRgb(self, pixel, expected, atol=1e-6):
        want = torch.tensor(expected, dtype=torch.float32)
        self.assertTrue(
            torch.allclose(pixel, want, atol=atol),
            f"expected rgb {tuple(round(v, 4) for v in want.tolist())}, "
            f"got {tuple(round(v, 4) for v in pixel.tolist())}"
        )

    def test_strip_directions_and_spacing(self):
        red = solid((1, 0, 0), h=2, w=2)
        green = solid((0, 1, 0), h=2, w=2)

        right = ms._compose([red, green], "strip", "right", False, 3, 1, "custom", "#336699")
        self.assertEqual(tuple(right.shape), (1, 2, 5, 3))
        self.assertRgb(right[0, 0, 0], (1, 0, 0))
        self.assertRgb(right[0, 0, 4], (0, 1, 0))
        self.assertRgb(right[0, 0, 2], (0x33 / 255, 0x66 / 255, 0x99 / 255), atol=1e-5)

        left = ms._compose([red, green], "strip", "left", False, 3, 0, "white", "#000000")
        self.assertRgb(left[0, 0, 0], (0, 1, 0))
        self.assertRgb(left[0, 0, -1], (1, 0, 0))

        down = ms._compose([red, green], "strip", "down", False, 3, 0, "white", "#000000")
        self.assertEqual(tuple(down.shape), (1, 4, 2, 3))
        self.assertRgb(down[0, 0, 0], (1, 0, 0))
        self.assertRgb(down[0, -1, 0], (0, 1, 0))

        up = ms._compose([red, green], "strip", "up", False, 3, 0, "white", "#000000")
        self.assertRgb(up[0, 0, 0], (0, 1, 0))
        self.assertRgb(up[0, -1, 0], (1, 0, 0))

    def test_grid_positions_are_unique_and_in_bounds(self):
        rows, cols, count = 2, 3, 5
        for direction in ("right", "left", "down", "up"):
            with self.subTest(direction=direction):
                positions = [ms._grid_position(i, rows, cols, direction) for i in range(count)]
                self.assertEqual(len(set(positions)), count)
                self.assertTrue(all(0 <= r < rows and 0 <= c < cols for r, c in positions))

    def test_grid_compose_shape_and_custom_background(self):
        a = solid((1, 0, 0), h=2, w=3)
        b = solid((0, 1, 0), h=4, w=2)
        out = ms._compose([a, b], "grid", "right", False, 2, 1, "custom", "#102030")
        self.assertEqual(tuple(out.shape), (1, 4, 7, 3))
        self.assertRgb(out[0, 3, 0], (0x10 / 255, 0x20 / 255, 0x30 / 255), atol=1e-5)

    def test_estimate_matches_actual_compose(self):
        images = [solid((1, 0, 0), h=2, w=3), solid((0, 1, 0), h=4, w=2)]
        dims = [(3, 2), (2, 4)]
        for layout in ("strip", "grid"):
            for direction in ("right", "left", "down", "up"):
                for match in (False, True):
                    with self.subTest(layout=layout, direction=direction, match=match):
                        out = ms._compose(images, layout, direction, match, 2, 1, "white", "#808080")
                        expected_w, expected_h = ms._estimate_output_dimensions(
                            dims,
                            layout,
                            direction,
                            match,
                            2,
                            1,
                        )
                        self.assertEqual((out.shape[2], out.shape[1]), (expected_w, expected_h))

    def test_rotation_crop_dimensions_and_loading(self):
        path = self.root / "sample.png"
        Image.new("RGB", (100, 60), (255, 0, 0)).save(path)
        item = {
            "filename": "sample.png",
            "type": "input",
            "rotation": 90,
            "flip_h": True,
            "crop": {"x": 0.25, "y": 0.1, "w": 0.5, "h": 0.5},
        }
        dims = ms._item_output_dimensions(item)
        tensor = ms._load_image(item)
        self.assertEqual(dims, (30, 50))
        self.assertEqual((tensor.shape[2], tensor.shape[1]), dims)

    def test_unsafe_path_is_rejected(self):
        """Traversal, absolute paths, drive letters and NUL bytes are refused.

        In its own temporary folder: the parent of the input folder is the
        system temp directory, which nothing in a test may write to.
        """
        with tempfile.TemporaryDirectory() as elsewhere:
            outside = Path(elsewhere) / "outside.png"
            Image.new("RGB", (4, 4)).save(outside)
            for item in (
                {"filename": "../outside.png"},
                {"filename": "outside.png", "subfolder": ".."},
                {"filename": "sub/../../outside.png"},
                {"filename": str(outside)},
                {"filename": "C:/outside.png"},
                {"filename": "C:\\outside.png"},
                {"filename": ".."},
                {"filename": "."},
            ):
                with self.subTest(**item):
                    with self.assertRaisesRegex(ValueError, "unsafe image path rejected"):
                        ms._safe_input_path(dict(item, type="input"))
            self.assertTrue(outside.is_file(), "nothing outside the input folder is touched")

    def test_a_nul_byte_is_the_nodes_own_error(self):
        """Python's own "embedded null byte" from os.stat says nothing useful."""
        for item in ({"filename": "x\x00.png"}, {"filename": "x.png", "subfolder": "s\x00ub"}):
            with self.subTest(**item):
                with self.assertRaisesRegex(ValueError, "Multi Stitch Images: unsafe image path rejected"):
                    ms._safe_input_path(dict(item, type="input"))

    def test_missing_file_names_the_item_not_the_server_path(self):
        """The absolute path on the server is nothing the user can act on."""
        with self.assertRaises(FileNotFoundError) as caught:
            ms._safe_input_path({"filename": "gone.png", "subfolder": "sub", "type": "input"})
        self.assertEqual(str(caught.exception), "Multi Stitch Images: image not found: sub/gone.png")
        self.assertNotIn(str(self.root), str(caught.exception))

    def test_a_symlinked_subfolder_inside_input_is_accepted(self):
        """ComfyUI's own Load Image follows a link inside input/, so this must.

        The check is lexical, like ComfyUI's: it refuses `..`, an absolute path
        and a NUL byte, and leaves symlinks alone, so a subfolder that lives on
        another disk still stitches.
        """
        with tempfile.TemporaryDirectory() as elsewhere:
            target = Path(elsewhere)
            Image.new("RGB", (6, 4), (0, 128, 255)).save(target / "linked.png")
            try:
                (self.root / "shared").symlink_to(target, target_is_directory=True)
            except OSError as exc:  # pragma: no cover - a filesystem without links
                self.skipTest(f"this filesystem cannot make symlinks ({exc})")
            item = {"filename": "linked.png", "subfolder": "shared", "type": "input"}
            path = ms._safe_input_path(item)
            self.assertEqual(path, self.root / "shared" / "linked.png")
            self.assertEqual(ms._item_output_dimensions(item), (6, 4))
            self.assertRgb(ms._load_image(item)[0, 0, 0], (0.0, 128 / 255, 1.0), atol=1e-4)

    def test_output_size_guard(self):
        width, height = ms._estimate_output_dimensions(
            [(8000, 8000)] * 4,
            "grid",
            "right",
            False,
            2,
            0,
        )
        self.assertEqual((width, height), (16000, 16000))
        with self.assertRaisesRegex(ValueError, "estimated output"):
            ms._validate_output_dimensions(width, height)

    def test_empty_input_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "at least one image"):
            ms._estimate_output_dimensions([], "strip", "right", True, 3, 0)

    def test_grid_shape_leaves_no_unused_row_or_column(self):
        """down/up fill column-first, so the canvas must not keep spare columns.

        Regression: 4 images at grid_columns=3 / direction=down allocated three
        columns but filled only two, emitting a bare spacing-colour band.
        """
        for direction in ("right", "left", "down", "up"):
            for count in range(1, 24):
                for grid_columns in range(1, 17):
                    rows, cols = ms._grid_shape(count, grid_columns, direction)
                    placed = [
                        ms._grid_position(i, rows, cols, direction)
                        for i in range(count)
                    ]
                    with self.subTest(d=direction, n=count, gc=grid_columns):
                        self.assertEqual(len(set(placed)), count, "cells collide")
                        for row, col in placed:
                            self.assertTrue(0 <= row < rows and 0 <= col < cols)
                        self.assertEqual(
                            {c for _, c in placed}, set(range(cols)), "unused column"
                        )
                        self.assertEqual(
                            {r for r, _ in placed}, set(range(rows)), "unused row"
                        )

    def test_grid_down_has_no_blank_column(self):
        images = [solid((1.0, 0.0, 0.0), 4, 4) for _ in range(4)]
        output = ms._compose(images, "grid", "down", True, 3, 0, "white", "#808080")
        # Two columns of 4px, not three: no bare white band on the right.
        self.assertEqual((output.shape[2], output.shape[1]), (8, 8))
        self.assertRgb(output[0, 0, 4], (1.0, 0.0, 0.0))

    def test_non_finite_rotation_falls_back_to_zero(self):
        """json.loads accepts Infinity, and round(inf) raises OverflowError."""
        item = json.loads('{"rotation": Infinity}')
        self.assertEqual(ms._normalize_transform(item), (0, False, False))
        for value in (float("-inf"), float("nan"), "abc", None):
            with self.subTest(rotation=value):
                self.assertEqual(
                    ms._normalize_transform({"rotation": value}), (0, False, False)
                )
        self.assertEqual(ms._normalize_transform({"rotation": -90}), (270, False, False))

    def test_source_pixel_guard_looks_at_the_original_not_the_crop(self):
        """A tiny crop still costs a full decode of the original."""
        item = {"filename": "huge.png", "crop": {"x": 0, "y": 0, "w": 0.01, "h": 0.01}}
        with self.assertRaisesRegex(ValueError, r"huge\.png.*20,000 × 20,000.*per-image"):
            ms._validate_source_pixels(item, 20000, 20000)
        ms._validate_source_pixels(item, 8000, 6000)

    def test_inspect_item_reports_source_and_output_sizes(self):
        self.write_png("wide.png", (1, 2, 3), size=(40, 10))
        item = {"filename": "wide.png", "type": "input", "rotation": 90,
                "crop": {"x": 0, "y": 0, "w": 0.5, "h": 0.5}}
        source, output = ms._inspect_item(item)
        self.assertEqual(source, (40, 10))   # what decoding costs
        self.assertEqual(output, (5, 20))    # rotated to 10x40, then half of each

    def test_measurement_pass_never_decodes_pixels(self):
        """The safety guards only earn their keep if they run before decoding."""
        base = Image.new("RGB", (100, 60), (5, 6, 7))
        exif = Image.Exif()
        exif[ms._EXIF_ORIENTATION] = 6
        base.save(self.root / "plain.png")
        base.save(self.root / "oriented.png", exif=exif.tobytes())
        base.save(self.root / "plain.jpg", quality=90)
        base.save(self.root / "oriented.jpg", quality=90, exif=exif.tobytes())

        real_load = ImageFile.ImageFile.load
        for name in ("plain.png", "oriented.png", "plain.jpg", "oriented.jpg"):
            loads = []
            ImageFile.ImageFile.load = lambda image, seen=loads: (seen.append(1), real_load(image))[1]
            try:
                source, output = ms._inspect_item({"filename": name, "type": "input"})
            finally:
                ImageFile.ImageFile.load = real_load
            with self.subTest(file=name):
                self.assertEqual(loads, [], "measuring decoded the image")
                expected = (60, 100) if name.startswith("oriented") else (100, 60)
                self.assertEqual(source, expected)
                self.assertEqual(output, expected)

    def test_exif_orientation_matches_pillow_for_every_value(self):
        """Measured size, decoded size and pixels agree with exif_transpose."""
        base = Image.new("RGB", (8, 5))
        for x in range(8):
            for y in range(5):
                base.putpixel((x, y), (x * 30, y * 50, 9))
        for orientation in range(1, 9):
            exif = Image.Exif()
            exif[ms._EXIF_ORIENTATION] = orientation
            path = self.root / f"o{orientation}.png"
            base.save(path, exif=exif.tobytes())
            item = {"filename": path.name, "type": "input"}
            with self.subTest(orientation=orientation):
                _, (width, height) = ms._inspect_item(item)
                tensor = ms._load_image(item)
                self.assertEqual((tensor.shape[2], tensor.shape[1]), (width, height))
                with Image.open(path) as image:
                    reference = np.asarray(ImageOps.exif_transpose(image).convert("RGB"))
                decoded = (tensor[0].numpy() * 255).round().astype(np.uint8)
                self.assertTrue(np.array_equal(decoded, reference))

    def test_compose_streams_one_source_at_a_time(self):
        """Loaders run once each, in placement order, and never overlap in memory."""
        dims = [(4, 3), (6, 2), (3, 5), (2, 2)]
        refs, order, alive_at_call = [], [], []

        def loader(index, width, height):
            def load():
                alive_at_call.append(sum(1 for ref in refs if ref() is not None))
                tensor = torch.full((1, height, width, 3), index / 10)
                refs.append(weakref.ref(tensor))
                order.append(index)
                return tensor
            return load

        for layout, direction in (("grid", "down"), ("strip", "left"), ("strip", "up")):
            refs.clear(); order.clear(); alive_at_call.clear()
            with self.subTest(layout=layout, direction=direction):
                loaders = [loader(i, w, h) for i, (w, h) in enumerate(dims)]
                streamed, _ = ms._compose_from(loaders, dims, layout, direction, True, 3, 1, "white", "#808080")
                eager = ms._compose(
                    [torch.full((1, h, w, 3), i / 10) for i, (w, h) in enumerate(dims)],
                    layout, direction, True, 3, 1, "white", "#808080",
                )
                self.assertEqual(sorted(order), list(range(len(dims))))
                self.assertEqual(alive_at_call, [0] * len(dims), "a previous source was still resident")
                self.assertTrue(torch.equal(streamed, eager))

    def test_compose_from_validates_before_calling_any_loader(self):
        calls = []
        loaders = [lambda: (calls.append(1), torch.zeros(1, 1, 1, 3))[1]] * 2
        with self.assertRaisesRegex(ValueError, "estimated output"):
            ms._compose_from(loaders, [(100000, 100000), (1, 1)], "strip", "right", False, 3, 0, "white", "#808080")
        self.assertEqual(calls, [])

    def test_compose_from_reports_a_source_that_changed_size(self):
        loaders = [lambda: torch.zeros(1, 9, 9, 3)]
        with self.assertRaisesRegex(ValueError, "decoded to 1×9×9×3 but was measured as 4×4"):
            ms._compose_from(loaders, [(4, 4)], "strip", "right", False, 3, 0, "white", "#808080")

    def test_image_cap_is_shared_with_the_frontend(self):
        shared_js = (MODULE_PATH.parent / "web" / "shared.js").read_text(encoding="utf-8")
        match = re.search(r"export const MAX_IMAGES = (\d+);", shared_js)
        self.assertIsNotNone(match, "web/shared.js must export MAX_IMAGES")
        self.assertEqual(int(match.group(1)), ms._MAX_IMAGES)

    def test_node_loads_as_a_comfyui_package(self):
        """A broken __init__ or RETURN_TYPES must fail here, not in ComfyUI."""
        package_root = MODULE_PATH.parent
        sys.path.insert(0, str(package_root.parent))
        try:
            package = importlib.import_module(package_root.name)
            importlib.reload(package)
        finally:
            sys.path.remove(str(package_root.parent))

        self.assertEqual(list(package.NODE_CLASS_MAPPINGS), ["MultiStitchImages"])
        self.assertEqual(
            package.NODE_DISPLAY_NAME_MAPPINGS["MultiStitchImages"], "Multi Stitch Images"
        )
        self.assertEqual(package.WEB_DIRECTORY, "./web")
        node = package.NODE_CLASS_MAPPINGS["MultiStitchImages"]
        self.assertEqual(node.RETURN_TYPES, ("IMAGE", "IMAGE", "INT", "INT"))
        self.assertEqual(node.RETURN_NAMES, ("image", "cells", "width", "height"))
        self.assertEqual(node.FUNCTION, "stitch")
        self.assertTrue(callable(getattr(node, node.FUNCTION)))
        for name in package.__all__:
            self.assertTrue(hasattr(package, name), name)

    def test_input_types_match_the_stitch_signature(self):
        """The widget order is load-bearing for the documented screenshots."""
        inputs = ms.MultiStitchImages.INPUT_TYPES()
        required = inputs["required"]
        self.assertEqual(
            list(required),
            [
                # The original eight stay first so saved workflows keep their
                # widget values aligned; later additions follow.
                "direction",
                "match_image_size",
                "spacing_width",
                "spacing_color",
                "images_json",
                "layout_mode",
                "grid_columns",
                "custom_spacing_color",
                "output_limit",
                "output_limit_px",
                "grid_cell_width",
                "grid_cell_height",
                "output_cells",
            ],
        )
        optional = inputs["optional"]
        self.assertEqual(
            list(optional),
            ["images", "cells_resolution", "minimum_image_side", "match_reference",
             "size_reference", "size_megapixels", "size_divisible_by"],
        )
        self.assertEqual(optional["images"][0], "IMAGE")
        self.assertEqual(optional["match_reference"][0], list(ms._MATCH_REFERENCES))
        self.assertEqual(optional["match_reference"][1]["default"], "smallest")
        self.assertEqual(optional["size_reference"][0], "INT")
        self.assertEqual(optional["size_reference"][1]["default"], 1)
        self.assertEqual((optional["size_reference"][1]["min"], optional["size_reference"][1]["max"]), (1, ms._MAX_IMAGES))
        self.assertEqual(optional["size_megapixels"][0], "FLOAT")
        self.assertEqual(optional["size_megapixels"][1]["default"], 0.0)
        self.assertEqual(optional["size_divisible_by"][0], "INT")
        self.assertEqual(optional["size_divisible_by"][1]["default"], 32)
        parameters = inspect.signature(ms.MultiStitchImages.stitch).parameters
        self.assertEqual(list(parameters)[1:], list(required) + list(optional))
        # A prompt that omits the value predates the option: keep matching to the first image.
        self.assertEqual(parameters["match_reference"].default, "first")
        # Defaults reproduce the behaviour before these widgets existed.
        for name in ("output_limit", "output_limit_px", "grid_cell_width", "grid_cell_height", "output_cells"):
            self.assertEqual(parameters[name].default, required[name][1]["default"], name)
        for name in ("size_reference", "size_megapixels", "size_divisible_by"):
            self.assertEqual(parameters[name].default, optional[name][1]["default"], name)
        # Odd gaps work, so the arrows must offer them: step 1, not 2.
        self.assertEqual(required["spacing_width"][1]["step"], 1)
        self.assertEqual(required["output_limit"][0], list(ms._OUTPUT_LIMITS))
        self.assertEqual(required["spacing_color"][0][-1], "custom")
        self.assertEqual(required["direction"][0], list(ms._DIRECTIONS))
        self.assertEqual(required["layout_mode"][0], list(ms._LAYOUT_MODES))

    def write_png(self, name, rgb, size=(2, 2)):
        path = self.root / name
        Image.new("RGB", size, rgb).save(path)
        return {"filename": name, "type": "input"}

    def test_stitch_end_to_end(self):
        """Covers the actual node entry point, not just the helpers."""
        red = self.write_png("r.png", (255, 0, 0))
        blue = self.write_png("b.png", (0, 0, 255))
        output, cells, width, height = ms.MultiStitchImages().stitch(
            direction="right",
            match_image_size=True,
            spacing_width=0,
            spacing_color="white",
            images_json=json.dumps([red, blue]),
            layout_mode="strip",
            grid_columns=3,
            custom_spacing_color="#808080",
        )
        self.assertIs(cells, output, "with output_cells off the second output is the image")
        self.assertEqual(output.shape, (1, 2, 4, 3))
        self.assertEqual(output.dtype, torch.float32)
        self.assertRgb(output[0, 0, 0], (1.0, 0.0, 0.0))
        self.assertRgb(output[0, 0, 3], (0.0, 0.0, 1.0))
        self.assertEqual((width, height), (32, 32), "the 2×2 first image, snapped up to the default multiple")

    def test_stitch_outputs_the_reference_size(self):
        """width/height describe one source as measured for the canvas, not the canvas."""
        small = self.write_png("small.png", (255, 0, 0), size=(30, 20))
        big = self.write_png("big.png", (0, 0, 255), size=(100, 60))
        common = dict(
            direction="right", match_image_size=True, spacing_width=0, spacing_color="white",
            images_json=json.dumps([small, big]), layout_mode="strip", grid_columns=3,
            custom_spacing_color="#808080",
        )
        image, _, width, height = ms.MultiStitchImages().stitch(**common)
        self.assertEqual(tuple(image.shape), (1, 20, 63, 3), "the strip itself is unchanged")
        self.assertEqual((width, height), (32, 32), "first image, 30×20 snapped to 32s")
        self.assertIsInstance(width, int)
        self.assertIsInstance(height, int)
        _, _, width, height = ms.MultiStitchImages().stitch(**common, size_reference=2, size_divisible_by=4)
        self.assertEqual((width, height), (100, 60))
        _, _, width, height = ms.MultiStitchImages().stitch(
            **common, size_reference=2, size_megapixels=1.0, size_divisible_by=32,
        )
        self.assertEqual((width, height), (1280, 768), "100×60 scaled to 1 MP keeps its 5:3 shape")
        # Crop and rotation count: the size is the image's footprint on the canvas.
        edited = dict(small, rotation=90, crop={"x": 0, "y": 0, "w": 1, "h": 0.5})
        _, _, width, height = ms.MultiStitchImages().stitch(
            **dict(common, images_json=json.dumps([edited, big])), size_divisible_by=1,
        )
        self.assertEqual((width, height), (20, 15))
        # Frames from the IMAGE input are candidates too.
        _, _, width, height = ms.MultiStitchImages().stitch(
            **common, images=torch.zeros(1, 200, 300, 3), size_reference=3, size_divisible_by=1,
        )
        self.assertEqual((width, height), (300, 200), "IMAGE-input frames count after the pasted images")
        _, _, width, height = ms.MultiStitchImages().stitch(**common, size_reference=7, size_divisible_by=1)
        self.assertEqual((width, height), (100, 60), "a number past the end means the last image")
        with self.assertRaisesRegex(ValueError, "size_reference must be an image number"):
            ms.MultiStitchImages().stitch(**common, size_reference="biggest")

    def test_stitch_rejects_too_many_images(self):
        item = self.write_png("many.png", (1, 2, 3))
        node = ms.MultiStitchImages()
        with self.assertRaisesRegex(ValueError, "maximum 256"):
            node.stitch(
                direction="right",
                match_image_size=True,
                spacing_width=0,
                spacing_color="white",
                images_json=json.dumps([item] * 257),
                layout_mode="strip",
                grid_columns=3,
                custom_spacing_color="#808080",
            )

    def test_rotation_and_flip_move_the_marked_corner(self):
        """Dimension-only assertions let a reversed rotation through."""
        # Distinct corners, so any wrong transform lands a different colour.
        source = Image.new("RGB", (2, 2))
        source.putpixel((0, 0), (255, 0, 0))    # top-left
        source.putpixel((1, 0), (0, 255, 0))    # top-right
        source.putpixel((0, 1), (0, 0, 255))    # bottom-left
        source.putpixel((1, 1), (255, 255, 0))  # bottom-right
        source.save(self.root / "corners.png")

        red, green, blue, yellow = (1.0, 0, 0), (0, 1.0, 0), (0, 0, 1.0), (1.0, 1.0, 0)
        # Where the originally-top-left red pixel ends up, per transform.
        expected = {
            (0, False, False): (0, 0), (0, True, False): (0, 1),
            (0, False, True): (1, 0), (0, True, True): (1, 1),
            (90, False, False): (0, 1), (90, True, False): (0, 0),
            (90, False, True): (1, 1), (90, True, True): (1, 0),
            (180, False, False): (1, 1), (180, True, False): (1, 0),
            (180, False, True): (0, 1), (180, True, True): (0, 0),
            (270, False, False): (1, 0), (270, True, False): (1, 1),
            (270, False, True): (0, 0), (270, True, True): (0, 1),
        }
        for (rotation, flip_h, flip_v), (row, col) in expected.items():
            with self.subTest(rotation=rotation, flip_h=flip_h, flip_v=flip_v):
                tensor = ms._load_image({
                    "filename": "corners.png", "type": "input",
                    "rotation": rotation, "flip_h": flip_h, "flip_v": flip_v,
                })
                self.assertRgb(tensor[0, row, col], red)
                # The other three corners must still be the other three colours.
                seen = {tuple(round(v, 3) for v in tensor[0, r, c].tolist())
                        for r in (0, 1) for c in (0, 1)}
                self.assertEqual(seen, {red, green, blue, yellow})

    def test_cropping_first_selects_the_same_pixels(self):
        """Cropping in source coordinates must be pixel-identical to cropping the
        transformed image, for every orientation, rotation, flip and crop."""
        rng = random.Random(4711)
        for trial in range(120):
            width, height = rng.randint(1, 13), rng.randint(1, 13)
            pixels = rng.randbytes(width * height * 3)
            base = Image.frombytes("RGB", (width, height), pixels)
            orientation = rng.randint(1, 8)
            exif = Image.Exif()
            exif[ms._EXIF_ORIENTATION] = orientation
            base.save(self.root / "case.png", exif=exif.tobytes())
            x, y = rng.random(), rng.random()
            item = {
                "filename": "case.png", "type": "input",
                "rotation": rng.choice([0, 90, 180, 270]),
                "flip_h": rng.choice([True, False]),
                "flip_v": rng.choice([True, False]),
                "crop": {"x": x, "y": y, "w": rng.random() * (1 - x), "h": rng.random() * (1 - y)},
            }
            with self.subTest(trial=trial, size=(width, height), orientation=orientation, item=item):
                new = ms._load_image(item)
                old = load_the_whole_image_first(item)
                self.assertEqual(tuple(new.shape), tuple(old.shape))
                self.assertTrue(torch.equal(new, old), "the crop mapping picked other pixels")
                self.assertEqual((new.shape[2], new.shape[1]), ms._item_output_dimensions(item))

    def test_the_transforms_only_ever_see_the_crop(self):
        """A small crop of a big original must not rotate the whole thing first."""
        self.write_png("big.png", (1, 2, 3), size=(80, 40))
        item = {"filename": "big.png", "type": "input", "rotation": 90, "flip_v": True,
                "crop": {"x": 0.5, "y": 0.5, "w": 0.25, "h": 0.25}}
        sizes, crops = [], []
        real_transpose, real_crop = Image.Image.transpose, Image.Image.crop

        def spy_transpose(image, method):
            sizes.append(image.size)
            return real_transpose(image, method)

        def spy_crop(image, box=None):
            crops.append(box)
            return real_crop(image, box)

        with patch.object(Image.Image, "transpose", spy_transpose), \
                patch.object(Image.Image, "crop", spy_crop):
            tensor = ms._load_image(item)
        self.assertEqual(tuple(tensor.shape), (1, 20, 10, 3))
        self.assertEqual(crops, [(20, 10, 40, 20)], "the crop box is mapped back into the source")
        self.assertEqual(sizes, [(20, 10), (10, 20)], "a full-size copy was transformed")

    def test_spacing_color_fills_bars_and_letterbox_in_both_layouts(self):
        """strip and grid used to disagree for red/green/blue."""
        tall = solid((0.0, 0.0, 0.0), 4, 2)
        wide = solid((0.0, 0.0, 0.0), 2, 2)
        for name, rgb in (
            ("white", (1.0, 1.0, 1.0)), ("black", (0.0, 0.0, 0.0)),
            ("red", (1.0, 0.0, 0.0)), ("green", (0.0, 1.0, 0.0)),
            ("blue", (0.0, 0.0, 1.0)),
        ):
            with self.subTest(spacing_color=name):
                strip = ms._compose([tall, wide], "strip", "right", False, 3, 1, name, "#808080")
                grid = ms._compose([tall, wide], "grid", "right", False, 3, 1, name, "#808080")
                self.assertRgb(strip[0, 3, 3], rgb)  # letterbox under the short image
                self.assertRgb(strip[0, 0, 2], rgb)  # separator bar
                self.assertRgb(grid[0, 3, 3], rgb)
        custom = ms._compose([tall, wide], "strip", "right", False, 3, 1, "custom", "#336699")
        self.assertRgb(custom[0, 3, 3], (0x33 / 255, 0x66 / 255, 0x99 / 255), atol=1e-3)

    def test_transparency_is_composited_onto_the_background(self):
        path = self.root / "clear.png"
        Image.new("RGBA", (2, 2), (255, 0, 0, 0)).save(path)
        item = {"filename": "clear.png", "type": "input"}
        # Dropping alpha would expose the hidden red instead of the background.
        self.assertRgb(ms._load_image(item, (1.0, 1.0, 1.0))[0, 0, 0], (1.0, 1.0, 1.0))
        self.assertRgb(ms._load_image(item, (0.0, 0.0, 0.0))[0, 0, 0], (0.0, 0.0, 0.0))
        Image.new("RGBA", (2, 2), (255, 0, 0, 128)).save(self.root / "half.png")
        blended = ms._load_image({"filename": "half.png", "type": "input"}, (1.0, 1.0, 1.0))
        # alpha_composite over white: 255 - 128 = 127 on the zeroed channels.
        self.assertRgb(blended[0, 0, 0], (1.0, 127 / 255, 127 / 255), atol=1e-4)

    def test_high_bit_depth_greys_keep_their_value(self):
        """convert("RGB") keeps the low 8 bits, so mid-grey came out white."""
        Image.fromarray(np.full((4, 6), 32768, dtype=np.uint16)).save(self.root / "mid16.png")
        with Image.open(self.root / "mid16.png") as check:
            # Pillow 11 and later read a 16-bit PNG as I;16, older ones as I.
            # Both hold 0..65535, and both used to clip to solid white.
            self.assertIn(check.mode, {"I;16", "I"}, "a 16-bit PNG must stay 16-bit")
        item = {"filename": "mid16.png", "type": "input"}
        tensor = ms._load_image(item)
        self.assertEqual(tuple(tensor.shape), (1, 4, 6, 3))
        self.assertEqual(ms._item_output_dimensions(item), (6, 4))
        self.assertRgb(tensor[0, 0, 0], (0.5, 0.5, 0.5), atol=2e-5)

        # The whole range maps to 0..1, in order, and each sample fills all three
        # channels — a 16-bit file is grey, not a red channel on its own.
        ramp = np.array([[0, 21845], [43690, 65535]], dtype=np.uint16)
        Image.fromarray(ramp).save(self.root / "ramp16.png")
        tensor = ms._load_image({"filename": "ramp16.png", "type": "input"})
        self.assertEqual(
            [round(v, 4) for v in tensor[0, :, :, 0].flatten().tolist()],
            [0.0, 0.3333, 0.6667, 1.0],
        )
        for channel in (1, 2):
            self.assertTrue(torch.equal(tensor[0, :, :, channel], tensor[0, :, :, 0]))

        # A 16-bit TIFF lands in the same modes, and a crop of one still lines up.
        Image.fromarray(ramp).save(self.root / "ramp16.tiff")
        cropped = {"filename": "ramp16.tiff", "type": "input", "rotation": 90,
                   "crop": {"x": 0, "y": 0, "w": 0.5, "h": 1}}
        tensor = ms._load_image(cropped)
        self.assertEqual(tuple(tensor.shape), (1, 2, 1, 3))
        # A quarter turn clockwise puts the ramp's bottom row in the left column,
        # which is the half this crop keeps.
        self.assertEqual([round(v, 4) for v in tensor[0, :, 0, 0].tolist()], [0.6667, 1.0])

    def test_integer_and_float_greys_scale_by_their_range(self):
        """"I" holds a 16-bit PNG's range, "F" holds 0..1; above that, normalise."""
        Image.new("I", (3, 2), 30000).save(self.root / "i32.tiff")
        self.assertRgb(
            ms._load_image({"filename": "i32.tiff", "type": "input"})[0, 0, 0],
            (30000 / 65535,) * 3, atol=1e-5,
        )
        Image.new("I", (3, 2), 200000).save(self.root / "i32big.tiff")
        self.assertRgb(ms._load_image({"filename": "i32big.tiff", "type": "input"})[0, 0, 0], (1.0, 1.0, 1.0))
        Image.new("F", (3, 2), 0.25).save(self.root / "f32.tiff")
        self.assertRgb(ms._load_image({"filename": "f32.tiff", "type": "input"})[0, 0, 0], (0.25, 0.25, 0.25))
        Image.new("F", (3, 2), 4.0).save(self.root / "f32big.tiff")
        self.assertRgb(ms._load_image({"filename": "f32big.tiff", "type": "input"})[0, 0, 0], (1.0, 1.0, 1.0))
        # A negative float sample cannot darken past black.
        Image.new("F", (3, 2), -2.0).save(self.root / "f32neg.tiff")
        self.assertRgb(ms._load_image({"filename": "f32neg.tiff", "type": "input"})[0, 0, 0], (0.0, 0.0, 0.0))

    def test_cmyk_greyscale_and_palette_sources_still_convert(self):
        """The modes a phone, a scanner or a screenshot actually produces."""
        Image.new("CMYK", (4, 6), (255, 0, 0, 0)).save(self.root / "cyan.jpg", quality=95)
        with Image.open(self.root / "cyan.jpg") as check:
            self.assertEqual(check.mode, "CMYK")
        item = {"filename": "cyan.jpg", "type": "input"}
        tensor = ms._load_image(item)
        self.assertEqual(tuple(tensor.shape), (1, 6, 4, 3))
        self.assertRgb(tensor[0, 0, 0], (0.0, 1.0, 1.0), atol=1e-2)

        # Greyscale with alpha: the transparent part shows the node background.
        Image.new("LA", (2, 3), (255, 0)).save(self.root / "clear.png")
        self.assertRgb(ms._load_image({"filename": "clear.png", "type": "input"}, (0.0, 0.0, 0.0))[0, 0, 0],
                       (0.0, 0.0, 0.0))
        Image.new("LA", (2, 3), (128, 255)).save(self.root / "grey.png")
        self.assertRgb(ms._load_image({"filename": "grey.png", "type": "input"}, (0.0, 0.0, 0.0))[0, 0, 0],
                       (128 / 255,) * 3, atol=1e-4)

        # A palette image with a transparent index: the same, per index.
        palette = Image.new("P", (2, 2), 1)
        palette.putpalette([255, 0, 0, 0, 255, 0])
        palette.putpixel((0, 0), 0)
        palette.save(self.root / "flag.png", transparency=0)
        tensor = ms._load_image({"filename": "flag.png", "type": "input"}, (0.0, 0.0, 1.0))
        self.assertRgb(tensor[0, 0, 0], (0.0, 0.0, 1.0), atol=1e-4)
        self.assertRgb(tensor[0, 1, 1], (0.0, 1.0, 0.0), atol=1e-4)
        palette.save(self.root / "opaque.png")
        self.assertRgb(ms._load_image({"filename": "opaque.png", "type": "input"})[0, 0, 0], (1.0, 0.0, 0.0), atol=1e-4)

    def test_invalid_choices_are_rejected(self):
        image = solid((1.0, 1.0, 1.0))
        with self.assertRaisesRegex(ValueError, "direction must be one of"):
            ms._compose([image], "strip", "sideways", True, 3, 0, "white", "#808080")
        with self.assertRaisesRegex(ValueError, "layout_mode must be one of"):
            ms._compose([image], "mosaic", "right", True, 3, 0, "white", "#808080")
        with self.assertRaisesRegex(ValueError, "spacing_color must be one of"):
            ms._compose([image], "strip", "right", True, 3, 0, "purple", "#808080")

    def test_unreadable_source_reports_in_the_nodes_voice(self):
        (self.root / "broken.png").write_bytes(b"not an image")
        with self.assertRaisesRegex(ValueError, r"Multi Stitch Images: could not read"):
            ms._load_image({"filename": "broken.png", "type": "input"})

        self.write_png("small.png", (1, 2, 3))
        limit = Image.MAX_IMAGE_PIXELS
        Image.MAX_IMAGE_PIXELS = 1
        try:
            with self.assertRaisesRegex(ValueError, "decompression-bomb"):
                ms._item_output_dimensions({"filename": "small.png", "type": "input"})
        finally:
            Image.MAX_IMAGE_PIXELS = limit

    def test_layout_places_every_image_inside_the_canvas_without_overlap(self):
        """The one layout description feeds the estimate, the compose and the preview."""
        random.seed(1234)
        for _ in range(300):
            count = random.randint(1, 7)
            dims = [(random.randint(1, 40), random.randint(1, 40)) for _ in range(count)]
            layout = random.choice(ms._LAYOUT_MODES)
            direction = random.choice(ms._DIRECTIONS)
            match = random.choice([True, False])
            columns = random.randint(1, 6)
            spacing = random.choice([0, 1, 3])
            cell_w, cell_h = random.choice([(0, 0), (17, 9), (30, 30)])
            width, height, placements = ms._layout(dims, layout, direction, match, columns, spacing, cell_w, cell_h)
            with self.subTest(dims=dims, layout=layout, direction=direction, match=match, columns=columns, spacing=spacing, cell=(cell_w, cell_h)):
                self.assertEqual(len(placements), count)
                for x, y, w, h in placements:
                    self.assertTrue(w >= 1 and h >= 1 and x >= 0 and y >= 0 and x + w <= width and y + h <= height, (x, y, w, h))
                for i in range(count):
                    for j in range(i + 1, count):
                        a, b = placements[i], placements[j]
                        overlap = a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]
                        self.assertFalse(overlap, (a, b))
                image = ms._compose(
                    [torch.rand(1, h, w, 3) for w, h in dims], layout, direction, match, columns, spacing,
                    "white", "#808080", grid_cell_width=cell_w, grid_cell_height=cell_h,
                )
                self.assertEqual((image.shape[2], image.shape[1]), (width, height))

    def test_match_reference_picks_the_shared_side_in_a_strip_and_area_in_a_grid(self):
        """largest/smallest never depend on list order; the reference keeps its size."""
        dims = [(40, 40), (20, 20), (30, 60)]
        strip = ms._prepared_strip_dims
        self.assertEqual(strip(dims, "right", True), [(40, 40), (40, 40), (20, 40)])
        self.assertEqual(strip(dims, "right", True, "smallest"), [(20, 20), (20, 20), (10, 20)])
        self.assertEqual(strip(dims, "right", True, "largest"), [(60, 60), (60, 60), (30, 60)])
        # Vertical strips share the width instead.
        self.assertEqual(strip(dims, "down", True, "smallest"), [(20, 20), (20, 20), (20, 40)])
        self.assertEqual(strip(dims, "up", True, "largest"), [(40, 40), (40, 40), (40, 80)])
        # A tie goes to the earlier image, so nothing moves.
        self.assertEqual(strip([(10, 10), (20, 10)], "right", True, "largest"), [(10, 10), (20, 10)])
        self.assertEqual(strip(dims, "right", False, "largest"), dims, "off means native sizes")

        # Grid: the reference by area becomes the cell every image is fitted into.
        grid = [(10, 60), (90, 5), (30, 20)]
        width, height, placed = ms._layout(grid, "grid", "right", True, 3, 0, match_reference="largest")
        self.assertEqual((width, height), (30, 60), "the 10×60 image wins the 600-pixel tie by coming first")
        self.assertEqual([(w, h) for _, _, w, h in placed], [(10, 60), (10, 1), (10, 7)])
        width, height, placed = ms._layout(grid, "grid", "right", True, 3, 0, match_reference="smallest")
        self.assertEqual((width, height), (270, 5))
        self.assertEqual([(w, h) for _, _, w, h in placed], [(1, 5), (90, 5), (8, 5)])
        self.assertEqual(ms._layout(grid, "grid", "right", True, 3, 0)[2][1][2:], (10, 1), "first is unchanged")

        with self.assertRaises(ValueError):
            ms._layout([(1, 1)], "strip", "right", True, 3, 0, match_reference="biggest")
        with self.assertRaises(ValueError):
            ms._layout(dims, "strip", "right", False, 3, 0, match_reference="biggest")

    def test_reference_size_follows_the_chosen_image(self):
        """The width/height outputs: one image's size, picked by its number in the list."""
        dims = [(40, 30), (20, 80), (60, 20), (10, 120)]  # areas 1200, 1600, 1200, 1200
        self.assertEqual(ms._reference_size(dims, 1, 0, 1), (40, 30))
        self.assertEqual(ms._reference_size(dims, 2, 0, 1), (20, 80))
        self.assertEqual(ms._reference_size(dims, 4, 0, 1), (10, 120))
        self.assertEqual(ms._reference_size(dims, 9, 0, 1), (10, 120), "past the end: the last image")
        self.assertEqual(ms._reference_size(dims, 0, 0, 1), (40, 30), "below one: the first image")
        self.assertEqual(ms._reference_size(dims, "3", 0, 1), (60, 20), "a numeric string counts")
        # The names the option briefly used still resolve, so nothing saved with them breaks.
        self.assertEqual(ms._reference_size(dims, "first", 0, 1), (40, 30))
        self.assertEqual(ms._reference_size(dims, "largest", 0, 1), (20, 80))
        self.assertEqual(ms._reference_size(dims, "smallest", 0, 1), (40, 30), "the first of three 1200-pixel images")
        with self.assertRaisesRegex(ValueError, "size_reference must be an image number"):
            ms._reference_size(dims, "biggest", 0, 1)
        with self.assertRaisesRegex(ValueError, "at least one image"):
            ms._reference_size([], 1, 0, 1)

    def test_reference_size_rescales_to_megapixels_and_snaps_to_a_multiple(self):
        # 1440×2560 at 0.8 MP: scale = sqrt(800000 / 3686400) = 0.4659, so 670.9×1192.6, each to the nearest 32.
        self.assertEqual(ms._reference_size([(1440, 2560)], "first", 0.8, 32), (672, 1184))
        self.assertEqual(ms._reference_size([(1440, 2560)], "first", 0.0, 32), (1440, 2560))
        self.assertEqual(ms._reference_size([(1440, 2560)], "first", None, 32), (1440, 2560))
        self.assertEqual(ms._reference_size([(1000, 500)], "first", 2.0, 1), (2000, 1000))
        # Nearest multiple; a side exactly between two goes to the even one (Python's round).
        self.assertEqual(ms._reference_size([(47, 81)], "first", 0, 32), (32, 96))
        self.assertEqual(ms._reference_size([(50, 78)], "first", 0, 32), (64, 64))
        self.assertEqual(ms._reference_size([(48, 80)], "first", 0, 32), (64, 64))
        self.assertEqual(ms._reference_size([(112, 16)], "first", 0, 32), (128, 32), "3.5 → 4 multiples; 0.5 → 0, floored to 1")
        # A multiple of 0 or less means no snapping; nothing ever drops below one multiple.
        self.assertEqual(ms._reference_size([(7, 9)], "first", 0, 0), (7, 9))
        self.assertEqual(ms._reference_size([(7, 9)], "first", 0, -4), (7, 9))
        self.assertEqual(ms._reference_size([(7, 9)], "first", 0, None), (7, 9))
        self.assertEqual(ms._reference_size([(1, 1)], "first", 0, 32), (32, 32))
        self.assertEqual(ms._reference_size([(100, 100)], "first", 0.0001, 8), (8, 8))
        width, height = ms._reference_size([(3, 5)], "first", 1.5, 8)
        self.assertEqual((type(width), type(height)), (int, int))
        self.assertEqual((width % 8, height % 8), (0, 0))

    def test_strip_left_and_up_draw_the_first_image_last(self):
        dims = [(4, 2), (6, 2), (2, 2)]
        _, _, right = ms._layout(dims, "strip", "right", False, 3, 1)
        _, _, left = ms._layout(dims, "strip", "left", False, 3, 1)
        _, _, up = ms._layout(dims, "strip", "up", False, 3, 1)
        self.assertEqual([p[0] for p in right], [0, 5, 12])
        self.assertEqual([p[0] for p in left], [10, 3, 0])
        self.assertEqual([p[1] for p in up], [6, 3, 0])

    def test_explicit_grid_cells_fit_every_image_without_stretching(self):
        width, height, placements = ms._layout([(10, 60), (90, 5), (30, 20)], "grid", "right", False, 3, 0, 30, 20)
        self.assertEqual((width, height), (90, 20))
        self.assertEqual(placements, [(13, 0, 3, 20), (30, 9, 30, 2), (60, 0, 30, 20)])
        # A cell given on one side only falls back to automatic sizing.
        self.assertEqual(ms._layout([(10, 60), (90, 5)], "grid", "right", False, 3, 0, 30, 0)[:2], (180, 60))

    def test_output_limit_only_shrinks(self):
        self.assertEqual(ms._limited_size(400, 200, "none", 100), (400, 200))
        self.assertEqual(ms._limited_size(400, 200, "max_width", 100), (100, 50))
        self.assertEqual(ms._limited_size(400, 200, "max_height", 100), (200, 100))
        self.assertEqual(ms._limited_size(400, 200, "max_long_side", 100), (100, 50))
        self.assertEqual(ms._limited_size(400, 200, "max_width", 5000), (400, 200))
        with self.assertRaisesRegex(ValueError, "output_limit must be one of"):
            ms._limited_size(400, 200, "shrink", 100)
        image = ms._compose(
            [solid((1.0, 0.0, 0.0), 200, 400)], "strip", "right", True, 3, 0, "white", "#808080",
            output_limit="max_width", output_limit_px=100,
        )
        self.assertEqual(tuple(image.shape), (1, 50, 100, 3))
        self.assertRgb(image[0, 25, 50], (1.0, 0.0, 0.0), atol=1e-3)

    def test_cells_output_is_a_uniform_batch_on_the_background(self):
        red = solid((1.0, 0.0, 0.0), 4, 4)
        blue = solid((0.0, 0.0, 1.0), 2, 6)
        image, cells = ms._compose_from(
            [lambda: red, lambda: blue], [(4, 4), (6, 2)], "strip", "right", False, 3, 1, "white", "#808080",
            output_cells=True,
        )
        self.assertEqual(tuple(image.shape), (1, 4, 11, 3))
        self.assertEqual(tuple(cells.shape), (2, 4, 6, 3))
        self.assertRgb(cells[0, 2, 2], (1.0, 0.0, 0.0))
        self.assertRgb(cells[0, 0, 0], (1.0, 1.0, 1.0))
        self.assertRgb(cells[1, 1, 3], (0.0, 0.0, 1.0))
        self.assertRgb(cells[1, 3, 3], (1.0, 1.0, 1.0))
        with self.assertRaisesRegex(ValueError, "cells output would be"):
            ms._validate_cells_output(300, 10000, 10000)

    def test_placed_cells_follow_the_output_limit(self):
        """placed means "the size the image has in the stitched result", which
        the output limit shrinks; the cells used to keep the pre-limit size."""
        red = solid((1.0, 0.0, 0.0), 40, 40)
        blue = solid((0.0, 0.0, 1.0), 20, 60)
        image, cells = ms._compose_from(
            [lambda: red, lambda: blue], [(40, 40), (60, 20)], "strip", "right", False, 3, 0,
            "white", "#808080", output_limit="max_long_side", output_limit_px=50, output_cells=True,
        )
        # 100×40 capped to a 50 px long side: everything at half size.
        self.assertEqual(tuple(image.shape), (1, 20, 50, 3))
        self.assertEqual(tuple(cells.shape), (2, 20, 30, 3))
        self.assertRgb(cells[0, 10, 15], (1.0, 0.0, 0.0), atol=1e-3)   # 20×20, centred
        self.assertRgb(cells[0, 10, 1], (1.0, 1.0, 1.0))               # background beside it
        self.assertRgb(cells[1, 10, 15], (0.0, 0.0, 1.0), atol=1e-3)   # 30×10, centred
        self.assertRgb(cells[1, 1, 15], (1.0, 1.0, 1.0))

        # Without a limit the cells keep the placed size, as before.
        _, cells = ms._compose_from(
            [lambda: red, lambda: blue], [(40, 40), (60, 20)], "strip", "right", False, 3, 0,
            "white", "#808080", output_cells=True,
        )
        self.assertEqual(tuple(cells.shape), (2, 40, 60, 3))
        # And a cell never disappears, however hard the canvas is squeezed.
        _, cells = ms._compose_from(
            [lambda: solid((1.0, 0.0, 0.0), 2, 2)], [(2, 2)], "strip", "right", False, 3, 0,
            "white", "#808080", output_limit="max_long_side", output_limit_px=1, output_cells=True,
        )
        self.assertEqual(tuple(cells.shape), (1, 1, 1, 3))
        self.assertEqual(ms._scaled_side(3, 0.5), 2, "half to even, like _limited_size")
        self.assertEqual(ms._scaled_side(1, 0.5), 1, "never below one pixel")

    def test_validate_inputs_reports_a_bad_list_at_queue_time(self):
        """ComfyUI asks before the prompt runs; the answer must be cheap."""
        item = self.write_png("ok.png", (1, 2, 3))
        node = ms.MultiStitchImages
        self.assertEqual(
            list(inspect.signature(node.VALIDATE_INPUTS).parameters), ["images_json"],
            "naming more inputs would take ComfyUI's own range checks over",
        )
        self.assertIs(node.VALIDATE_INPUTS(json.dumps([item])), True)
        self.assertIs(node.VALIDATE_INPUTS("[]"), True)
        self.assertIs(node.VALIDATE_INPUTS(), True)
        self.assertIs(node.VALIDATE_INPUTS(json.dumps(["junk", 7])), True, "the frontend owns the entries")
        self.assertIn("corrupted image list", node.VALIDATE_INPUTS("[{oops}"))
        self.assertIn("must be an array", node.VALIDATE_INPUTS('{"filename": "ok.png"}'))
        self.assertEqual(
            node.VALIDATE_INPUTS(json.dumps([{"filename": "gone.png"}])),
            "Multi Stitch Images: image not found: gone.png",
        )
        self.assertIn("unsafe image path", node.VALIDATE_INPUTS(json.dumps([{"filename": "../ok.png"}])))
        with patch.object(Image, "open", side_effect=AssertionError("decoded")):
            self.assertIs(node.VALIDATE_INPUTS(json.dumps([item])), True)

    def test_image_input_frames_are_appended_after_the_pasted_images(self):
        green = self.write_png("green.png", (0, 255, 0), size=(4, 2))
        batch = torch.zeros(3, 2, 4, 4)
        batch[0, ..., 0] = 1
        batch[0, ..., 3] = 1         # opaque red
        batch[1, ..., 3] = 0         # fully transparent: shows the background
        batch[2, ..., :3] = 0.5
        batch[2, ..., 3] = 1         # opaque grey
        image, _, *_ = ms.MultiStitchImages().stitch(
            direction="right", match_image_size=True, spacing_width=0, spacing_color="blue",
            images_json=json.dumps([green]), layout_mode="strip", grid_columns=3, custom_spacing_color="#808080",
            images=batch,
        )
        self.assertEqual(tuple(image.shape), (1, 2, 16, 3))
        self.assertRgb(image[0, 0, 0], (0.0, 1.0, 0.0))
        self.assertRgb(image[0, 0, 4], (1.0, 0.0, 0.0))
        self.assertRgb(image[0, 0, 8], (0.0, 0.0, 1.0))
        self.assertRgb(image[0, 0, 12], (0.5, 0.5, 0.5))

        grey, _, *_ = ms.MultiStitchImages().stitch(
            "right", True, 0, "white", "[]", "strip", 3, "#808080", images=torch.full((1, 2, 4, 1), 0.25),
        )
        self.assertEqual(tuple(grey.shape), (1, 2, 4, 3))
        self.assertRgb(grey[0, 0, 0], (0.25, 0.25, 0.25))

        with self.assertRaisesRegex(ValueError, r"maximum 256 images.*1 pasted \+ 256 from the IMAGE input"):
            ms.MultiStitchImages().stitch(
                "right", True, 0, "white", json.dumps([green]), "strip", 3, "#808080", images=torch.zeros(256, 2, 2, 3),
            )
        with self.assertRaisesRegex(ValueError, "expected 1, 3 or 4"):
            ms.MultiStitchImages().stitch("right", True, 0, "white", "[]", "strip", 3, "#808080", images=torch.zeros(1, 2, 2, 2))


if __name__ == "__main__":
    unittest.main()
