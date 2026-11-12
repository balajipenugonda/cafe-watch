import unittest
from objects import OBJECT_LABELS, object_evidence, apply_object_evidence


def answer(**scores):
    return {'probabilities':{key:scores.get(key,0.01) for key in OBJECT_LABELS}}

def decision(status='free',visible=.98):
    return {'status':status,'confidence':.95,'reason':'Original reason',
            'signals':{'table_visible':visible,'guest_present':0,'surface':'clear','surface_confidence':.95}}


class ObjectEvidenceTests(unittest.TestCase):
    def test_only_confident_known_objects_are_shown(self):
        objects,scores=object_evidence(answer(dishes=.96,drinkware=.79))
        self.assertEqual([item['key'] for item in objects],['dishes'])
        self.assertEqual(scores['drinkware'],.79)

    def test_incomplete_or_invalid_probabilities_are_rejected(self):
        with self.assertRaises(ValueError):object_evidence({'probabilities':{'dishes':.9}})
        for score in [float('nan'),float('inf'),-1,2,True,'0.9']:
            with self.assertRaises(ValueError):object_evidence(answer(dishes=score))

    def test_decor_does_not_make_a_ready_table_dirty(self):
        self.assertEqual(apply_object_evidence(decision(),answer(decor=.96))['status'],'free')

    def test_items_conflicting_with_ready_require_review(self):
        result=apply_object_evidence(decision(),answer(bottles=.95,books_papers=.9))
        self.assertEqual(result['status'],'unknown')
        self.assertEqual(result['confidence'],0)
        self.assertIn('bottles',result['reason'].lower())

    def test_occupied_table_keeps_objects_without_becoming_dirty(self):
        result=apply_object_evidence(decision('occupied'),answer(dishes=.95,food=.9))
        self.assertEqual(result['status'],'occupied')
        self.assertEqual(len(result['objects']),2)

    def test_no_object_is_claimed_when_table_is_not_visible(self):
        result=apply_object_evidence(decision('unknown',.2),answer(dishes=.99))
        self.assertEqual(result['objects'],[])
        self.assertEqual(result['object_scores'],{})

    def test_dirty_table_with_only_decor_does_not_invent_clearing_items(self):
        result=apply_object_evidence(decision('dirty'),answer(decor=.96))
        self.assertIn('uncertain',result['reason'])
