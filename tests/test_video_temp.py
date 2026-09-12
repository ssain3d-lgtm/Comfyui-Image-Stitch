"""The temporary-video helpers behind the frame picker: only a plain video
file name inside temp/multi_stitch_video may ever be deleted, and the route's
response is built by a pure function so it is checked without aiohttp."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import test_multi_stitch as support

ms = support.ms


class TempVideoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patch = patch.object(ms.folder_paths, "get_temp_directory", lambda: str(self.root))
        self.patch.start()
        self.folder = self.root / ms._VIDEO_SUBFOLDER
        self.folder.mkdir()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def video(self, name, content=b"webm"):
        path = self.folder / name
        path.write_bytes(content)
        return path

    def test_deletes_only_a_video_inside_the_temp_subfolder(self):
        path = self.video("clip.webm")
        self.assertTrue(ms._delete_temp_video("clip.webm"))
        self.assertFalse(path.exists())
        self.assertFalse(ms._delete_temp_video("clip.webm"), "already gone")

    def test_rejects_anything_that_is_not_a_plain_video_name(self):
        outside = self.root / "keep.mp4"
        outside.write_bytes(b"x")
        (self.folder / "notes.txt").write_bytes(b"x")
        for name in ("../keep.mp4", "sub/clip.mp4", "..", "", None, "notes.txt", "clip.png", "clip.mp4\x00"):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    ms._delete_temp_video(name)
        self.assertTrue(outside.exists())
        self.assertTrue((self.folder / "notes.txt").exists())

    def test_route_response_reports_removed_missing_and_rejected(self):
        self.video("a.mp4")
        status, body = ms._video_delete_response({"filenames": ["a.mp4", "b.mp4", "../c.mp4"]})
        self.assertEqual(status, 200)
        self.assertEqual(body, {"removed": ["a.mp4"], "missing": ["b.mp4"], "rejected": ["../c.mp4"]})
        self.assertFalse((self.folder / "a.mp4").exists())

        self.assertEqual(ms._video_delete_response({"filename": "x.mov"})[1]["missing"], ["x.mov"])
        self.assertEqual(ms._video_delete_response({"filenames": ["../c.mp4"]})[0], 400)
        self.assertEqual(ms._video_delete_response(None)[0], 400)
        self.assertEqual(ms._video_delete_response({"filenames": []})[0], 400)
        self.assertEqual(ms._video_delete_response({"filenames": ["a"] * 65})[0], 400)

    def test_the_stitch_never_sees_videos(self):
        """Captured frames are ordinary items; the video entry lives only in the browser."""
        self.assertNotIn("kind", ms.MultiStitchImages.INPUT_TYPES()["required"])
        self.assertNotIn("video", ms.MultiStitchImages.INPUT_TYPES()["optional"])


if __name__ == "__main__":
    unittest.main()
