"""Associate full-frame person detections with nearby mapped tables."""
import math


def table_overlap(region, candidates):
    best = 0.0
    for other in candidates:
        intersection = max(0,min(region['x']+region['w'],other['x']+other['w'])-max(region['x'],other['x'])) * max(0,min(region['y']+region['h'],other['y']+other['h'])-max(region['y'],other['y']))
        union = region['w']*region['h']+other['w']*other['h']-intersection
        best = max(best, intersection/union if union else 0)
    return best


def associate_people(regions, people):
    result = {r['id']: 0.0 for r in regions}
    for person in people:
        left, top, right, bottom, confidence = person
        if not all(math.isfinite(v) for v in person) or right <= left or bottom <= top:
            continue
        candidates = []
        for r in regions:
            x, y, w, h = r['x'], r['y'], r['w'], r['h']
            intersection = max(0, min(right, x+w)-max(left, x)) * max(0, min(bottom, y+h)-max(top, y))
            overlap = intersection / min((right-left)*(bottom-top), w*h)
            dx = max(0, x-right, left-x-w)
            vertical = max(0, min(bottom, y+h)-max(top, y)) / min(bottom-top, h)
            # A seated guest may sit just outside either side of the tabletop.
            if overlap >= .04 or (dx <= w*.30 and vertical >= .25):
                distance = abs((left+right)/2-(x+w/2))/w + abs((top+bottom)/2-(y+h/2))/h
                candidates.append((overlap - distance*.10, r['id']))
        if candidates:
            candidates.sort(reverse=True)
            score, target = candidates[0]
            if len(candidates)>1 and score-candidates[1][0]<.06:
                # Ambiguous seating between two tables needs review.
                for _, key in candidates[:2]:
                    result[key] = max(result[key], .5)
            else:
                result[target] = max(result[target], confidence)
    return result
