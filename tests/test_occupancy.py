import unittest
from occupancy import associate_people, table_overlap


class OccupancyTests(unittest.TestCase):
    def table(self, key='1', x=.3):
        return {'id':key, 'x':x, 'y':.35, 'w':.25, 'h':.4}

    def test_seated_person_just_outside_table_box_is_counted(self):
        self.assertGreater(associate_people([self.table()], [[.57,.2,.8,.9,.92]])['1'], .9)

    def test_background_person_does_not_occupy_foreground_table(self):
        self.assertEqual(associate_people([self.table()], [[.3,.02,.4,.25,.95]])['1'], 0)

    def test_no_people_means_no_occupancy_evidence(self):
        self.assertEqual(associate_people([self.table()], [])['1'], 0)

    def test_camera_moving_to_a_person_or_wall_invalidates_table_match(self):
        self.assertEqual(table_overlap(self.table(), []), 0)
        self.assertEqual(table_overlap(self.table(), [self.table('2',.8)]), 0)
        self.assertAlmostEqual(table_overlap(self.table(), [self.table()]), 1)

    def test_person_is_associated_with_nearer_table(self):
        scores = associate_people([self.table('1',.1),self.table('2',.65)], [[.05,.2,.2,.85,.9]])
        self.assertEqual(scores['1'], .9)
        self.assertEqual(scores['2'], 0)
