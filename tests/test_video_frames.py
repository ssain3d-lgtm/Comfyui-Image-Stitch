"""Server-side frame extraction behind the frame picker. PyAV opens the
uploaded temp video, reports what the picker needs to scrub, and hands back
the frame on screen at a time: a JPEG preview, or a PNG capture saved to the
input folder. The clip is encoded by PyAV itself, so no video ships in the
repository, and the route responses are pure functions checked without
aiohttp, like the delete route's."""
import importlib.util
import io
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from PIL import Image

import test_multi_stitch as support

ms = support.ms
HAVE_AV = importlib.util.find_spec("av") is not None
FRAMES, RATE = 20, 10


def write_clip(path, size=(64, 64), frames=FRAMES, rotation=None, split="time"):
    """A tiny MPEG-4 clip: red then blue over time, or red left and blue right."""
    import av
    width, height = size
    with av.open(str(path), "w") as container:
        stream = container.add_stream("mpeg4", rate=RATE)
        stream.width, stream.height = width, height
        stream.pix_fmt = "yuv420p"
        if rotation is not None:
            stream.set_display_rotation(rotation)
        for index in range(frames):
            pixels = np.zeros((height, width, 3), dtype=np.uint8)
            if split == "time":
                pixels[..., 0 if index < frames // 2 else 2] = 255
            else:
                pixels[:, :width // 2, 0] = 255
                pixels[:, width // 2:, 2] = 255
            for packet in stream.encode(av.VideoFrame.from_ndarray(pixels, format="rgb24")):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def centre(image):
    return image.convert("RGB").getpixel((image.width // 2, image.height // 2))


@support.requires(HAVE_AV, "PyAV is not installed")
class VideoFrameTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.input = self.root / "input"
        self.input.mkdir()
        self.patches = [
            patch.object(ms.folder_paths, "get_temp_directory", lambda: str(self.root)),
            patch.object(ms.folder_paths, "get_input_directory", lambda: str(self.input)),
        ]
        for patcher in self.patches:
            patcher.start()
        self.folder = self.root / ms._VIDEO_SUBFOLDER
        self.folder.mkdir()
        write_clip(self.folder / "clip.mp4")

    def tearDown(self):
        for patcher in self.patches:
            patcher.stop()
        self.temp.cleanup()

    def assertReddish(self, pixel):
        self.assertTrue(pixel[0] > 180 and pixel[2] < 80, f"expected red-ish, got {pixel}")

    def assertBluish(self, pixel):
        self.assertTrue(pixel[2] > 180 and pixel[0] < 80, f"expected blue-ish, got {pixel}")

    def test_info_describes_the_first_video_stream(self):
        info = ms._video_info("clip.mp4")
        self.assertAlmostEqual(info["duration"], 2.0, delta=0.15)
        self.assertEqual(info["fps"], 10.0)
        self.assertEqual((info["width"], info["height"]), (64, 64))
        self.assertEqual(info["frames"], FRAMES)
        self.assertEqual(info["rotation"], 0)
        self.assertEqual(ms._video_info_response({"filename": "clip.mp4"}), (200, info))

    def test_frame_is_the_one_on_screen_at_that_time(self):
        self.assertReddish(centre(ms._video_frame("clip.mp4", 0.4)))
        self.assertBluish(centre(ms._video_frame("clip.mp4", 1.5)))
        # The frame at 0.9 s stays on screen until 1.0 s; the one at 1.0 s takes over exactly then.
        self.assertReddish(centre(ms._video_frame("clip.mp4", 0.99)))
        self.assertBluish(centre(ms._video_frame("clip.mp4", 1.0)))
        # Before the first frame and past the last, the nearest end is returned.
        self.assertReddish(centre(ms._video_frame("clip.mp4", -3)))
        self.assertBluish(centre(ms._video_frame("clip.mp4", 60)))
        image, seconds = ms._video_frame_at("clip.mp4", 60)
        self.assertEqual((image.mode, image.size), ("RGB", (64, 64)))
        self.assertEqual(seconds, ms._video_info("clip.mp4")["duration"])

    def test_containers_without_an_index_or_a_frame_count_still_work(self):
        """MPEG-TS seeks land on any packet and Matroska has no stream duration; both get uploaded."""
        for name in ("clip.ts", "clip.mkv"):
            with self.subTest(container=name):
                write_clip(self.folder / name)
                info = ms._video_info(name)
                self.assertAlmostEqual(info["duration"], 2.0, delta=0.15)
                self.assertEqual(info["fps"], 10.0)
                self.assertIn(info["frames"], (0, FRAMES))
                self.assertReddish(centre(ms._video_frame(name, 0.4)))
                self.assertBluish(centre(ms._video_frame(name, 1.5)))
                self.assertReddish(centre(ms._video_frame(name, 0.99)))
                self.assertBluish(centre(ms._video_frame(name, 60)))

    def test_rotation_is_read_the_way_a_player_reads_it(self):
        """The legacy tag is clockwise; the display matrix PyAV reports is counter-clockwise."""
        stream = SimpleNamespace(metadata={"rotate": "90"})
        self.assertEqual(ms._display_rotation(stream), 90)
        stream.metadata = {"rotate": "-90"}
        self.assertEqual(ms._display_rotation(stream), 270)
        stream.metadata = {}
        self.assertEqual(ms._display_rotation(stream), 0)
        self.assertEqual(ms._display_rotation(stream, SimpleNamespace(rotation=90)), 270)
        self.assertEqual(ms._display_rotation(stream, SimpleNamespace(rotation=-90)), 90)
        self.assertEqual(ms._display_rotation(stream, SimpleNamespace(rotation=-180)), 180)
        self.assertEqual(ms._display_rotation(stream, SimpleNamespace(rotation=None)), 0)
        stream.metadata = {"rotate": "sideways"}  # unreadable tag: fall through to the frame
        self.assertEqual(ms._display_rotation(stream, SimpleNamespace(rotation=-90)), 90)

    def test_a_clip_with_a_display_matrix_comes_back_upright(self):
        import av
        if not (hasattr(av.VideoStream, "set_display_rotation") and hasattr(av.VideoFrame, "rotation")):
            self.skipTest("this PyAV cannot write or read a display matrix")
        # PyAV's degrees are counter-clockwise: -90 is the portrait phone video players turn clockwise.
        write_clip(self.folder / "turned.mp4", size=(64, 32), frames=4, rotation=-90, split="side")
        info = ms._video_info("turned.mp4")
        self.assertEqual((info["width"], info["height"], info["rotation"]), (32, 64, 90))
        image = ms._video_frame("turned.mp4", 0.1)
        self.assertEqual(image.size, (32, 64))
        self.assertReddish(image.getpixel((16, 8)))   # the left half now sits on top
        self.assertBluish(image.getpixel((16, 56)))

    def test_capture_saves_a_full_size_png_in_the_input_folder(self):
        status, body = ms._video_capture_response({"filename": "clip.mp4", "time": 1.5})
        self.assertEqual(status, 200)
        self.assertEqual(
            {key: body[key] for key in ("subfolder", "type", "width", "height", "time")},
            {"subfolder": "multi_stitch", "type": "input", "width": 64, "height": 64, "time": 1.5},
        )
        self.assertRegex(body["name"], r"^multi_stitch_\d+_[0-9a-f]{8}\.png$")
        with Image.open(self.input / "multi_stitch" / body["name"]) as image:
            self.assertEqual((image.format, image.size), ("PNG", (64, 64)))
            self.assertBluish(centre(image))
        # The capture is an ordinary input image, addressed the way the stitch expects.
        item = {"filename": body["name"], "subfolder": body["subfolder"], "type": body["type"]}
        self.assertEqual(ms._item_output_dimensions(item), (64, 64))
        # A time past the end reports the time actually used.
        status, body = ms._video_capture_response({"filename": "clip.mp4", "time": "99"})
        self.assertEqual(status, 200)
        self.assertAlmostEqual(body["time"], 2.0, delta=0.15)

    def test_preview_is_a_jpeg_no_larger_than_max_side(self):
        status, body, content_type = ms._video_preview_response(
            {"filename": "clip.mp4", "time": "0.4", "max_side": "32"},
        )
        self.assertEqual((status, content_type), (200, "image/jpeg"))
        self.assertTrue(body.startswith(b"\xff\xd8"))
        with Image.open(io.BytesIO(body)) as image:
            self.assertEqual((image.format, image.size), ("JPEG", (32, 32)))
            self.assertReddish(centre(image))
        # A frame already within the default stays its own size; the cap bounds a silly request.
        status, body, _ = ms._video_preview_response({"filename": "clip.mp4", "time": 1.5})
        with Image.open(io.BytesIO(body)) as image:
            self.assertEqual(image.size, (64, 64))
            self.assertBluish(centre(image))
        self.assertEqual(ms._preview_max_side({"max_side": "100000"}), 2048)
        self.assertEqual(ms._preview_max_side({}), 720)
        # int(inf) raises OverflowError, which used to leave the route at 500.
        for bad in ("inf", "-inf", "nan", "abc", "", None):
            with self.subTest(max_side=bad):
                with self.assertRaisesRegex(ValueError, '"max_side" must be a number of pixels'):
                    ms._preview_max_side({"max_side": bad})
                status, body, content_type = ms._video_preview_response(
                    {"filename": "clip.mp4", "time": 0, "max_side": bad},
                )
                self.assertEqual((status, content_type), (400, "application/json"))
                self.assertIn("error", body)
        self.assertFalse(list(self.input.rglob("*")), "a preview writes nothing")

    def test_a_preview_is_scaled_while_the_frame_is_decoded(self):
        """swscale scales the native planes; converting a 4K frame to RGB in
        full and resizing the picture afterwards costs several times as much for
        the very same result size."""
        write_clip(self.folder / "wide.mp4", size=(96, 64), frames=4, split="side")
        for max_side in (7, 32, 33, 96, 720):
            with self.subTest(max_side=max_side):
                scale = min(1.0, max_side / 96)
                image, _ = ms._video_frame_at("wide.mp4", 0.1, max_side)
                self.assertEqual(image.size, (max(1, round(96 * scale)), max(1, round(64 * scale))))
                self.assertEqual(image.mode, "RGB")
        # Nothing is left for Pillow to resize, and the JPEG is the same size.
        with patch.object(Image.Image, "resize", side_effect=AssertionError("resized after decoding")):
            status, body, _ = ms._video_preview_response({"filename": "wide.mp4", "time": 0.1, "max_side": "32"})
        self.assertEqual(status, 200)
        with Image.open(io.BytesIO(body)) as image:
            self.assertEqual(image.size, (32, 21))
            self.assertReddish(image.convert("RGB").getpixel((7, 10)))
        # A capture keeps the full frame.
        image, _ = ms._video_frame_at("wide.mp4", 0.1)
        self.assertEqual(image.size, (96, 64))

        import av
        if not (hasattr(av.VideoStream, "set_display_rotation") and hasattr(av.VideoFrame, "rotation")):
            return
        # A turned clip is capped on the side the viewer sees as the long one.
        write_clip(self.folder / "turned.mp4", size=(96, 64), frames=4, rotation=-90, split="side")
        image, _ = ms._video_frame_at("turned.mp4", 0.1, 32)
        self.assertEqual(image.size, (21, 32))

    def test_bad_requests_get_the_right_status(self):
        for name in ("../clip.mp4", "clip.txt", "sub/clip.mp4", "", None):
            with self.subTest(name=name):
                self.assertEqual(ms._video_info_response({"filename": name})[0], 400)
        self.assertEqual(ms._video_info_response({})[0], 400)
        self.assertEqual(ms._video_info_response(None)[0], 400)
        self.assertEqual(ms._video_capture_response(["clip.mp4"])[0], 400)
        self.assertEqual(ms._video_info_response({"filename": "gone.mp4"})[0], 404)
        self.assertEqual(ms._video_capture_response({"filename": "gone.mp4", "time": 0})[0], 404)
        status, body, content_type = ms._video_preview_response({"filename": "gone.mp4", "time": "0"})
        self.assertEqual((status, content_type), (404, "application/json"))
        self.assertIn("error", body)
        for bad_time in ("abc", None, "nan", "inf", ""):
            with self.subTest(time=bad_time):
                self.assertEqual(ms._video_capture_response({"filename": "clip.mp4", "time": bad_time})[0], 400)
                self.assertEqual(ms._video_preview_response({"filename": "clip.mp4", "time": bad_time})[0], 400)
        self.assertEqual(ms._video_preview_response({"filename": "clip.mp4", "time": 0, "max_side": "big"})[0], 400)
        # A file that is not a video at all: PyAV cannot open it.
        (self.folder / "junk.mp4").write_bytes(b"not a video" * 100)
        status, body = ms._video_info_response({"filename": "junk.mp4"})
        self.assertEqual(status, 415)
        self.assertIn("error", body)
        self.assertEqual(ms._video_capture_response({"filename": "junk.mp4", "time": 0})[0], 415)
        self.assertFalse(list(self.input.rglob("*")), "nothing was captured")


class WithoutPyAVTests(unittest.TestCase):
    def test_routes_answer_501_when_pyav_is_missing(self):
        """The stitch never needs PyAV, so the module loads without it; only these routes say so."""
        with tempfile.TemporaryDirectory() as root:
            with patch.object(ms.folder_paths, "get_temp_directory", lambda: root):
                with patch.dict(sys.modules, {"av": None}):
                    status, body = ms._video_info_response({"filename": "clip.mp4"})
                    self.assertEqual((status, body), (501, {"error": "PyAV is not installed; run: pip install av"}))
                    self.assertEqual(ms._video_capture_response({"filename": "clip.mp4", "time": 0})[0], 501)
                    self.assertEqual(ms._video_preview_response({"filename": "clip.mp4", "time": 0})[0], 501)
                    # A bad name is still a bad request, PyAV or not.
                    self.assertEqual(ms._video_info_response({"filename": "../clip.mp4"})[0], 400)


if __name__ == "__main__":
    unittest.main()
