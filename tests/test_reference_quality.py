import json
import struct
import unittest
import zlib
from unittest.mock import patch
from PIL import Image, ImageOps
import torch
import test_multi_stitch as support

ms = support.ms


class ReferenceQualityTests(unittest.TestCase):
    setUp = support.MultiStitchTests.setUp
    tearDown = support.MultiStitchTests.tearDown
    write_png = support.MultiStitchTests.write_png
    assertRgb = support.MultiStitchTests.assertRgb

    def run_node(self, items=None, **kwargs):
        args = dict(direction='right', match_image_size=False, spacing_width=0,
                    spacing_color='white', images_json=json.dumps(items or []),
                    layout_mode='strip', grid_columns=3, custom_spacing_color='#808080')
        args.update(kwargs)
        return ms.MultiStitchImages().stitch(**args)

    def test_new_node_matches_the_first_image_at_native_resolution(self):
        inputs = ms.MultiStitchImages.INPUT_TYPES()
        self.assertTrue(inputs['required']['match_image_size'][1]['default'])
        self.assertEqual(inputs['required']['output_limit'][1]['default'], 'none')
        self.assertEqual(inputs['optional']['match_reference'][1]['default'], 'first')
        a = self.write_png('a.png', (255, 0, 0), (30, 10))
        b = self.write_png('b.png', (0, 0, 255), (60, 40))
        # The defaults: b takes a's height, nothing is enlarged or capped.
        output, _ = self.run_node([a, b], match_image_size=inputs['required']['match_image_size'][1]['default'])
        self.assertEqual(tuple(output.shape), (1, 10, 45, 3))
        # Matching off still keeps every native size.
        output, _ = self.run_node([a, b], match_image_size=False)
        self.assertEqual(tuple(output.shape), (1, 40, 90, 3))

    def test_source_cells_preserve_resolution_even_when_composite_shrinks(self):
        a = self.write_png('a.png', (255, 0, 0), (30, 10))
        b = self.write_png('b.png', (0, 0, 255), (60, 40))
        output, cells = self.run_node([a, b], match_image_size=True, output_limit='max_long_side',
                                      output_limit_px=20, output_cells=True, cells_resolution='source')
        self.assertEqual(output.shape[2], 20)
        self.assertEqual(tuple(cells.shape), (2, 40, 60, 3))
        self.assertRgb(cells[0, 15, 15], (1, 0, 0))
        self.assertRgb(cells[0, 14, 15], (1, 1, 1))
        self.assertTrue(torch.all(cells[1, :, :, 2] == 1))

    def test_source_cells_validate_memory_before_decoding(self):
        loads = []
        loaders = [lambda: loads.append(1)] * 2
        with patch.object(ms, '_MAX_OUTPUT_PIXELS', 1000):
            with self.assertRaisesRegex(ValueError, 'cells output'):
                ms._compose_from(loaders, [(1, 1), (100, 100)], 'grid', 'right', True,
                                 2, 0, 'white', '#808080', output_cells=True, cells_resolution='source')
        self.assertFalse(loads)

    def test_minimum_guard_rejects_before_decode(self):
        item = self.write_png('small.png', (1, 2, 3), (30, 20))
        with patch.object(ms, '_load_image', side_effect=AssertionError('decoded')):
            with self.assertRaisesRegex(ValueError, 'minimum_image_side'):
                self.run_node([item], output_limit='max_long_side', output_limit_px=10, minimum_image_side=10)

    def test_png_exif_after_pixels_is_read_without_decode(self):
        item = self.write_png('late.png', (255, 0, 0), (20, 30))
        path = self.root / 'late.png'
        exif = Image.Exif(); exif[274] = 6
        payload = exif.tobytes()[6:]
        chunk = struct.pack('>I', len(payload)) + b'eXIf' + payload + struct.pack('>I', zlib.crc32(b'eXIf' + payload))
        data = path.read_bytes()
        path.write_bytes(data[:-12] + chunk + data[-12:])
        with patch.object(Image.Image, 'load', side_effect=AssertionError('decoded')):
            self.assertEqual(ms._item_output_dimensions(item), (30, 20))
        tensor = ms._load_image(item)
        self.assertEqual(tuple(tensor.shape), (1, 20, 30, 3))
        with Image.open(path) as image:
            self.assertEqual(ImageOps.exif_transpose(image).size, (30, 20))

    def test_malformed_late_png_exif_is_ignored_not_fatal(self):
        """A truncated TIFF header inside eXIf makes Pillow raise struct.error."""
        item = self.write_png('broken.png', (255, 0, 0), (20, 30))
        path = self.root / 'broken.png'
        for junk in (b'MM\x00\x2a\x00\x00', b'\x00\x01\x02garbage!!', b''):
            chunk = struct.pack('>I', len(junk)) + b'eXIf' + junk + struct.pack('>I', zlib.crc32(b'eXIf' + junk))
            data = path.read_bytes()
            if b'eXIf' in data:
                self.write_png('broken.png', (255, 0, 0), (20, 30))
                data = path.read_bytes()
            path.write_bytes(data[:-12] + chunk + data[-12:])
            with self.subTest(junk=junk):
                self.assertEqual(ms._item_output_dimensions(item), (20, 30))
                self.assertEqual(tuple(ms._load_image(item).shape), (1, 30, 20, 3))

    def test_tiff_orientation_headers_are_respected(self):
        image = Image.new('RGB', (20, 30))
        exif = Image.Exif(); exif[274] = 6
        image.save(self.root / 'orientation.tiff', exif=exif)
        item = {'filename': 'orientation.tiff'}
        self.assertEqual(ms._item_output_dimensions(item), (30, 20))
        self.assertEqual(tuple(ms._load_image(item).shape), (1, 20, 30, 3))

    def test_file_replacement_invalidates_execution_cache(self):
        item = self.write_png('replace.png', (255, 0, 0))
        args = dict(images_json=json.dumps([item]))
        before = ms.MultiStitchImages.IS_CHANGED(**args)
        self.write_png('replace.png', (0, 0, 255), (10, 10))
        self.assertNotEqual(before, ms.MultiStitchImages.IS_CHANGED(**args))

    def test_connected_frames_are_lazy_and_shape_is_validated(self):
        frame = torch.zeros((2, 3, 4), dtype=torch.float16)
        with patch.object(torch.Tensor, 'to', side_effect=AssertionError('eager conversion')):
            loader, size = ms._frame_loader(frame, (1, 1, 1))
        self.assertEqual(size, (3, 2))
        self.assertEqual(tuple(loader().shape), (1, 2, 3, 3))
        with self.assertRaisesRegex(ValueError, 'nonempty'):
            self.run_node(images=torch.zeros((0, 2, 3, 3)))
        with self.assertRaisesRegex(ValueError, 'nonempty'):
            self.run_node(images=torch.zeros((2, 3, 3)))
