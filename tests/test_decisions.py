import unittest
from decisions import decide


def evidence(visible=.98, guest=.02, surface='clear', confidence=.95):
    state = 'occupied' if guest >= .75 else {'clear':'free', 'clutter':'dirty', 'uncertain':'unknown'}[surface]
    return {'visible': {'noul': visible}, 'guest': {'noul': guest},
            'state': {'choice': state, 'confidence': confidence}}


class DecisionTests(unittest.TestCase):
    def test_ready_requires_visible_clear_unoccupied_table(self):
        self.assertEqual(decide(evidence())['status'], 'free')

    def test_unattended_items_require_cleaning(self):
        result = decide(evidence(surface='clutter'))
        self.assertEqual(result['status'], 'dirty')
        self.assertIn('clearing', result['reason'])

    def test_occupied_takes_precedence_over_dishes(self):
        self.assertEqual(decide(evidence(guest=.96, surface='clutter'))['status'], 'occupied')
        a = evidence(guest=.96)
        a['state']['choice'] = 'dirty'
        self.assertEqual(decide(a)['status'], 'occupied')

    def test_unclear_visibility_never_means_ready_or_occupied(self):
        self.assertEqual(decide(evidence(visible=.4))['status'], 'unknown')
        self.assertEqual(decide(evidence(visible=.4, guest=.99))['status'], 'unknown')

    def test_ambiguous_occupancy_or_surface_requires_review(self):
        self.assertEqual(decide(evidence(guest=.5))['status'], 'unknown')
        self.assertEqual(decide(evidence(surface='uncertain'))['status'], 'unknown')
        self.assertEqual(decide(evidence(confidence=.5))['status'], 'unknown')
        self.assertEqual(decide(evidence(confidence=.75))['status'], 'unknown')

    def test_a_weak_negative_occupancy_score_does_not_override_a_clear_state(self):
        self.assertEqual(decide(evidence(guest=.39))['status'], 'free')
        self.assertEqual(decide(evidence(guest=.39, surface='clutter'))['status'], 'dirty')

    def test_bad_model_scores_are_rejected(self):
        for score in [float('nan'), float('inf'), -1, 2, True]:
            with self.assertRaises(ValueError): decide(evidence(visible=score))
