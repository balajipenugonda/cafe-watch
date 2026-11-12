"""Conservative policy for independent visibility, occupancy, and surface answers."""
import math

QUESTIONS = {
    'visible': {'type': 'noul', 'instructions': 'Is a table or desk with its tabletop visible in this image?'},
    'state': {
        'type': 'choice',
        'instructions': 'Classify the main table. A person using it means occupied, even with dishes. An unoccupied table with unattended items needs cleaning or clearing. Only call it ready when clear for the next guest. A small decorative vase or fixed table settings may stay.',
        'criteria': {'free': 'Unoccupied, clean tabletop, clear and ready for a new guest.',
                     'dirty': 'Unoccupied table with items to clear: used dishes, food, litter, bottles, books, papers, bags, or personal belongings.',
                     'occupied': 'A person is sitting at or actively using this table.',
                     'unknown': 'No recognizable table, obscured tabletop, or unclear condition.'},
    },
}


def probability(value):
    if isinstance(value, bool):
        raise ValueError('Invalid model score.')
    score = float(value)
    if not math.isfinite(score) or not 0 <= score <= 1:
        raise ValueError('Invalid model score.')
    return score


def decide(answers):
    visible = probability(answers['visible']['noul'])
    guest = probability(answers['guest']['noul'])
    choice = answers['state']['choice']
    surface = {'free': 'clear', 'dirty': 'clutter', 'occupied': 'in_use', 'unknown': 'uncertain'}.get(choice)
    surface_confidence = probability(answers['state']['confidence'])
    signals = {'table_visible': round(visible, 3), 'guest_present': round(guest, 3),
               'surface': surface, 'surface_confidence': round(surface_confidence, 3)}
    if surface is None:
        raise ValueError('Invalid surface decision.')
    status, confidence, reason = 'unknown', 0.0, 'Cannot confirm the table condition.'
    if visible < .75:
        reason = 'Tabletop is not clearly visible. Reposition the camera or redraw the box.'
    elif guest >= .75:
        status, confidence, reason = 'occupied', min(visible, guest), 'A guest is seated at or using this table.'
    elif choice == 'occupied' and guest >= .65 and surface_confidence >= .65:
        status, confidence, reason = 'occupied', min(visible, guest, surface_confidence), 'A guest is seated at or using this table.'
    elif guest >= .50 or choice == 'occupied':
        reason = 'Cannot confirm whether someone is using this table.'
    elif surface == 'uncertain' or surface_confidence < .65:
        reason = 'Tabletop condition is uncertain. Check the view and lighting.'
    elif surface == 'clear' and surface_confidence < .80:
        reason = 'Not enough evidence to call this table ready.'
    elif surface == 'clutter':
        status, confidence, reason = 'dirty', min(visible, surface_confidence), 'Unattended items need clearing from the tabletop.'
    else:
        status, confidence, reason = 'free', min(visible, surface_confidence), 'Table is clear and no guest is using it.'
    return {'status': status, 'confidence': confidence, 'reason': reason, 'signals': signals}
