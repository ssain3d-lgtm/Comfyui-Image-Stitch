import importlib
import importlib.util
import inspect
import json
import random
import re
import sys
import tempfile
import types
import unittest
import weakref
from pathlib import Path

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
        outside = self.root.parent / "outside.png"
        Image.new("RGB", (4, 4)).save(outside)
        try:
            with self.assertRaisesRegex(ValueError, "unsafe image path"):
                ms._safe_input_path({"filename": "../outside.png", "type": "input"})
        finally:
            outside.unlink(missing_ok=True)

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
            ImageFile.ImageFile.load = lambda image: (loads.append(1), real_load(image))[1]
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
        self.assertEqual(node.RETURN_TYPES, ("IMAGE", "IMAGE"))
        self.assertEqual(node.RETURN_NAMES, ("image", "cells"))
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
        self.assertEqual(list(inputs["optional"]), ["images"])
        self.assertEqual(inputs["optional"]["images"], ("IMAGE",))
        parameters = inspect.signature(ms.MultiStitchImages.stitch).parameters
        self.assertEqual(list(parameters)[1:], list(required) + list(inputs["optional"]))
        # Defaults reproduce the behaviour before these widgets existed.
        for name in ("output_limit", "output_limit_px", "grid_cell_width", "grid_cell_height", "output_cells"):
            self.assertEqual(parameters[name].default, required[name][1]["default"], name)
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
        output, cells = ms.MultiStitchImages().stitch(
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

    def test_image_input_frames_are_appended_after_the_pasted_images(self):
        green = self.write_png("green.png", (0, 255, 0), size=(4, 2))
        batch = torch.zeros(3, 2, 4, 4)
        batch[0, ..., 0] = 1
        batch[0, ..., 3] = 1         # opaque red
        batch[1, ..., 3] = 0         # fully transparent: shows the background
        batch[2, ..., :3] = 0.5
        batch[2, ..., 3] = 1         # opaque grey
        image, _ = ms.MultiStitchImages().stitch(
            direction="right", match_image_size=True, spacing_width=0, spacing_color="blue",
            images_json=json.dumps([green]), layout_mode="strip", grid_columns=3, custom_spacing_color="#808080",
            images=batch,
        )
        self.assertEqual(tuple(image.shape), (1, 2, 16, 3))
        self.assertRgb(image[0, 0, 0], (0.0, 1.0, 0.0))
        self.assertRgb(image[0, 0, 4], (1.0, 0.0, 0.0))
        self.assertRgb(image[0, 0, 8], (0.0, 0.0, 1.0))
        self.assertRgb(image[0, 0, 12], (0.5, 0.5, 0.5))

        grey, _ = ms.MultiStitchImages().stitch(
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
