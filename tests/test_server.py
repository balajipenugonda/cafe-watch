import base64
import unittest
from server import validate, detected_regions


class ValidationTests(unittest.TestCase):
    def test_detection_expands_context_clips_and_deduplicates(self):
        box = {'box': {'left': .01, 'top': .01, 'right': .3, 'bottom': .3}}
        regions = detected_regions([box, box, {'box': None}, {'box': {'left': .9, 'top': .1, 'right': .1, 'bottom': .3}}])
        self.assertEqual(len(regions), 1)
        self.assertEqual(regions[0]['x'], 0)
        self.assertEqual(regions[0]['y'], 0)
        self.assertGreater(regions[0]['w'], .3)
        self.assertEqual(regions[0]['name'], 'Table 01')

    def test_nested_tabletop_detection_is_not_a_second_table(self):
        small = {'box': {'left': .25, 'top': .25, 'right': .45, 'bottom': .35}}
        big = {'box': {'left': .20, 'top': .20, 'right': .5, 'bottom': .6}}
        self.assertEqual(len(detected_regions([small, big])), 1)

    def payload(self):
        return {'frame': 'data:image/jpeg;base64,' + base64.b64encode(b'test').decode(),
                'regions': [{'id': '1', 'x': .1, 'y': .2, 'w': .3, 'h': .4}]}

    def test_valid_crop(self):
        raw, regions = validate(self.payload())
        self.assertEqual(raw, b'test')
        self.assertEqual(regions[0]['id'], '1')

    def test_bad_regions(self):
        for key, value in [('x', -.1), ('y', float('nan')), ('w', 0), ('h', 1), ('x', True)]:
            p = self.payload()
            p['regions'][0][key] = value
            with self.assertRaises(ValueError):
                validate(p)

    def test_duplicate_ids_and_empty_regions(self):
        p = self.payload()
        p['regions'].append(p['regions'][0].copy())
        with self.assertRaises(ValueError): validate(p)
        p['regions'] = []
        with self.assertRaises(ValueError): validate(p)

    def test_non_image_and_bad_base64(self):
        p = self.payload()
        for frame in ['https://example.com/frame.jpg', 'data:image/jpeg;base64,??']:
            p['frame'] = frame
            with self.assertRaises(ValueError): validate(p)
