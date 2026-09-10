import importlib
import importlib.util
import inspect
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

import torch
from PIL import Image


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

    def test_input_pixel_guard_rejects_oversized_sources(self):
        """A small canvas can still decode gigabytes of sources first."""
        dimensions = [(32, 32)] + [(4000, 3000)] * 255
        # The output guard alone lets this through: match_image_size sizes every
        # cell from the first (tiny) image.
        width, height = ms._estimate_output_dimensions(
            dimensions, "grid", "right", True, 16, 0
        )
        ms._validate_output_dimensions(width, height)
        with self.assertRaisesRegex(ValueError, "source image"):
            ms._validate_input_pixels(dimensions)
        ms._validate_input_pixels([(4000, 3000)] * 10)

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
        self.assertEqual(node.RETURN_TYPES, ("IMAGE",))
        self.assertEqual(node.FUNCTION, "stitch")
        self.assertTrue(callable(getattr(node, node.FUNCTION)))
        for name in package.__all__:
            self.assertTrue(hasattr(package, name), name)

    def test_input_types_match_the_stitch_signature(self):
        """The widget order is load-bearing for the documented screenshots."""
        required = ms.MultiStitchImages.INPUT_TYPES()["required"]
        self.assertEqual(
            list(required),
            [
                "direction",
                "match_image_size",
                "spacing_width",
                "spacing_color",
                "images_json",
                "layout_mode",
                "grid_columns",
                "custom_spacing_color",
            ],
        )
        parameters = list(
            inspect.signature(ms.MultiStitchImages.stitch).parameters
        )[1:]
        self.assertEqual(parameters, list(required))
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
        (output,) = ms.MultiStitchImages().stitch(
            direction="right",
            match_image_size=True,
            spacing_width=0,
            spacing_color="white",
            images_json=json.dumps([red, blue]),
            layout_mode="strip",
            grid_columns=3,
            custom_spacing_color="#808080",
        )
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


if __name__ == "__main__":
    unittest.main()
