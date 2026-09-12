"""The temporary-video helpers behind the frame picker: only a plain video
file name inside temp/multi_stitch_video may ever be deleted, and the route's
response is built by a pure function so it is checked without aiohttp. The
routes themselves are mounted on a real aiohttp application at the end, with a
stand-in PromptServer, so the block that registers them is covered too."""
import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import test_multi_stitch as support

ms = support.ms
HAVE_AV = importlib.util.find_spec("av") is not None

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
except ImportError:  # pragma: no cover - ComfyUI always ships aiohttp
    web = None


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

    def test_a_name_the_filesystem_refuses_is_rejected_not_a_crash(self):
        """A directory under that name answered 500; so would Windows holding
        the file open while a decode still reads it."""
        (self.folder / "dir.mp4").mkdir()
        with self.assertRaisesRegex(ValueError, "could not delete the video"):
            ms._delete_temp_video("dir.mp4")
        self.video("a.mp4")
        status, body = ms._video_delete_response({"filenames": ["a.mp4", "dir.mp4"]})
        self.assertEqual(status, 200)
        self.assertEqual(body, {"removed": ["a.mp4"], "missing": [], "rejected": ["dir.mp4"]})
        self.assertTrue((self.folder / "dir.mp4").is_dir(), "the directory is left alone")

        self.video("busy.mp4")
        with patch.object(Path, "unlink", side_effect=PermissionError(13, "used by another process")):
            status, body = ms._video_delete_response({"filenames": ["busy.mp4"]})
        self.assertEqual(status, 400)
        self.assertEqual(body, {"removed": [], "missing": [], "rejected": ["busy.mp4"]})
        self.assertTrue((self.folder / "busy.mp4").is_file())

    def test_the_stitch_never_sees_videos(self):
        """Captured frames are ordinary items; the video entry lives only in the browser."""
        self.assertNotIn("kind", ms.MultiStitchImages.INPUT_TYPES()["required"])
        self.assertNotIn("video", ms.MultiStitchImages.INPUT_TYPES()["optional"])


class VideoFailureTests(unittest.TestCase):
    """What a failure inside the video helpers turns into for a route."""

    def test_a_filesystem_refusal_is_a_json_500_not_a_traceback(self):
        for error in (
            PermissionError(13, "permission denied"),
            IsADirectoryError(21, "is a directory"),
            OSError(28, "no space left on device"),
        ):
            with self.subTest(error=type(error).__name__):
                status, body = ms._video_failure(error)
                self.assertEqual(status, 500)
                self.assertTrue(body["error"].startswith("Multi Stitch Images:"), body)
        # The statuses above it keep their meaning, and a real bug still raises.
        self.assertEqual(ms._video_failure(FileNotFoundError("gone"))[0], 404)
        self.assertEqual(ms._video_failure(ValueError("bad name"))[0], 400)
        self.assertEqual(ms._video_failure(ImportError("no av"))[0], 501)
        with self.assertRaises(RuntimeError):
            ms._video_failure(RuntimeError("a bug"))


def load_module_with_routes(routes):
    """Import the module again with a stand-in PromptServer, so the route block
    at the bottom of it registers into `routes` instead of into ComfyUI."""
    server = types.ModuleType("server")
    server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes))
    spec = importlib.util.spec_from_file_location("multi_stitch_routes", support.MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    with patch.dict(sys.modules, {"server": server}):
        spec.loader.exec_module(module)
    return module


@support.requires(web is not None, "aiohttp is not installed")
class VideoRouteTests(unittest.IsolatedAsyncioTestCase):
    """The four routes over real HTTP: the handlers, the statuses and the JSON."""

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.routes = web.RouteTableDef()
        self.module = load_module_with_routes(self.routes)
        # Both folders, so a route can never reach for the real ComfyUI ones.
        self.patches = [
            patch.object(self.module.folder_paths, "get_temp_directory", lambda: str(self.root)),
            patch.object(self.module.folder_paths, "get_input_directory", lambda: str(self.root)),
        ]
        for patcher in self.patches:
            patcher.start()
        (self.root / ms._VIDEO_SUBFOLDER).mkdir()
        app = web.Application()
        app.add_routes(self.routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        for patcher in self.patches:
            patcher.stop()
        self.temp.cleanup()

    def test_every_route_is_registered_once(self):
        registered = sorted((route.method, route.path) for route in self.routes)
        self.assertEqual(registered, [
            ("GET", "/multi_stitch/video/frame"),
            ("GET", "/multi_stitch/video/info"),
            ("POST", "/multi_stitch/video/capture"),
            ("POST", "/multi_stitch/video/delete"),
        ])

    async def test_a_missing_video_is_404_and_a_bad_name_is_400(self):
        # Without PyAV the routes say so first; with it, the file is what is missing.
        missing = 404 if HAVE_AV else 501
        for path, params in (
            ("/multi_stitch/video/info", {"filename": "gone.mp4"}),
            ("/multi_stitch/video/frame", {"filename": "gone.mp4", "time": "0"}),
        ):
            with self.subTest(path=path):
                response = await self.client.get(path, params=params)
                self.assertEqual(response.status, missing)
                self.assertEqual(response.content_type, "application/json")
                self.assertIn("error", await response.json())
        response = await self.client.post("/multi_stitch/video/capture", json={"filename": "gone.mp4", "time": 0})
        self.assertEqual(response.status, missing)
        self.assertIn("error", await response.json())

        for path, params in (
            ("/multi_stitch/video/info", {"filename": "../escape.mp4"}),
            ("/multi_stitch/video/info", {"filename": "notes.txt"}),
            ("/multi_stitch/video/frame", {"filename": "clip.mp4", "time": "later"}),
            ("/multi_stitch/video/frame", {"filename": "clip.mp4", "time": "0", "max_side": "inf"}),
        ):
            with self.subTest(path=path, params=params):
                response = await self.client.get(path, params=params)
                self.assertEqual(response.status, 400, await response.text())
                self.assertIn("error", await response.json())

    async def test_delete_reports_what_it_did(self):
        (self.root / ms._VIDEO_SUBFOLDER / "clip.webm").write_bytes(b"webm")
        response = await self.client.post(
            "/multi_stitch/video/delete", json={"filenames": ["clip.webm", "gone.mp4", "../escape.mp4"]},
        )
        self.assertEqual(response.status, 200)
        self.assertEqual(
            await response.json(),
            {"removed": ["clip.webm"], "missing": ["gone.mp4"], "rejected": ["../escape.mp4"]},
        )
        response = await self.client.post("/multi_stitch/video/delete", json={"filename": "gone.mp4"})
        self.assertEqual((response.status, (await response.json())["missing"]), (200, ["gone.mp4"]))
        # A body that is not a JSON object at all, and one that is not JSON.
        response = await self.client.post("/multi_stitch/video/delete", json=["clip.webm"])
        self.assertEqual(response.status, 400)
        response = await self.client.post(
            "/multi_stitch/video/delete", data=b"{not json", headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status, 400)
        self.assertIn("error", await response.json())


if __name__ == "__main__":
    unittest.main()
