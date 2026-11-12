"""LiquidAI native multi-label object evidence; no generated text or guessed labels."""
import math

OBJECT_LABELS = {
    'dishes': 'Plates / bowls',
    'drinkware': 'Cups / glasses',
    'bottles': 'Bottles / cans',
    'books_papers': 'Books / papers',
    'personal_items': 'Personal belongings',
    'food': 'Food',
    'waste': 'Litter / spills',
    'decor': 'Table decor',
}

OBJECT_QUESTION = {
    'type': 'choice', 'multiple': True,
    'instructions': 'Which objects are visibly ON THE MAIN TABLETOP? Select every applicable category. Ignore objects on the floor, on nearby furniture, or in the background. Do not guess hidden objects.',
    'criteria': {
        'dishes': 'Plates, saucers, or bowls on this tabletop.',
        'drinkware': 'Drinking cups, coffee mugs, or drinking glasses on this tabletop.',
        'bottles': 'Drink bottles, flasks, or cans on this tabletop.',
        'books_papers': 'Books, notebooks, or papers on this tabletop.',
        'personal_items': 'A phone, laptop, bag, keys, or other personal belongings on this tabletop.',
        'food': 'Food or food leftovers on this tabletop.',
        'waste': 'Food crumbs, spilled drinks, crumpled disposable napkins, or litter on this tabletop.',
        'decor': 'An intentional decorative vase, small plant, or centerpiece on this tabletop.',
    },
}


def object_evidence(answer, threshold=.80):
    probabilities = answer.get('probabilities')
    if not isinstance(probabilities, dict) or set(probabilities) != set(OBJECT_LABELS):
        raise ValueError('Incomplete LiquidAI object probabilities.')
    scores = {}
    for key, value in probabilities.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError('Invalid LiquidAI object probability.')
        scores[key] = float(value)
    # The native API lists choices at >=50%; our UI uses a stricter 80% threshold.
    objects = [{'key':key, 'label':OBJECT_LABELS[key], 'confidence':score}
               for key, score in scores.items() if score >= threshold]
    objects.sort(key=lambda item:item['confidence'], reverse=True)
    return objects, scores


def apply_object_evidence(decision, answer):
    objects, scores = object_evidence(answer)
    result = {**decision, 'objects':objects, 'object_scores':scores, 'object_model':'LiquidAI/d1-2B'}
    if decision['status'] == 'unknown' and decision['signals']['table_visible'] < .75:
        # Items cannot be attributed to a table which was not verified as visible.
        result['objects'] = []
        result['object_scores'] = {}
        return result
    conflicts = [item for item in objects if item['key'] in {'bottles','books_papers','personal_items','food','waste'}]
    if decision['status'] == 'free' and conflicts:
        result.update(status='unknown', confidence=0,
                      reason='Object evidence conflicts with Ready: '+', '.join(item['label'].lower() for item in conflicts)+'. Review the tabletop.')
    elif decision['status'] == 'dirty':
        clearing=[item['label'].lower() for item in objects if item['key']!='decor']
        result['reason'] = 'Items need clearing: '+', '.join(clearing)+'.' if clearing else 'Table needs clearing; object types are uncertain.'
    return result
