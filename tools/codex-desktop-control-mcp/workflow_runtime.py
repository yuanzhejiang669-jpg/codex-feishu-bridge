from __future__ import annotations

import math
import time
from typing import Any, Callable


MAX_WORKFLOW_STEPS = 50


def compare_images(before, after, *, threshold: int = 12) -> dict[str, Any]:
    """Return compact, resolution-independent visual change metrics."""
    from PIL import ImageChops, ImageStat

    before_size = before.size
    after_size = after.size
    resized = before_size != after_size
    if resized:
        after = after.resize(before.size)
    left = before.convert('RGB')
    right = after.convert('RGB')
    diff = ImageChops.difference(left, right)
    grayscale = diff.convert('L')
    mask = grayscale.point(lambda value: 255 if value >= max(0, min(int(threshold), 255)) else 0)
    histogram = mask.histogram()
    changed_pixels = int(histogram[255])
    total_pixels = max(1, left.width * left.height)
    stat = ImageStat.Stat(diff)
    rms = math.sqrt(sum(value * value for value in stat.rms) / max(1, len(stat.rms)))
    bbox = mask.getbbox()
    return {
        'changed': changed_pixels > 0,
        'changed_pixels': changed_pixels,
        'total_pixels': total_pixels,
        'changed_ratio': changed_pixels / total_pixels,
        'rms_difference': float(rms),
        'changed_bbox': list(bbox) if bbox else None,
        'threshold': int(threshold),
        'size': [left.width, left.height],
        'before_size': list(before_size),
        'after_size': list(after_size),
        'resized_for_comparison': resized,
    }


def execute_workflow(
    steps: list[dict[str, Any]],
    dispatch: Callable[[str, dict[str, Any]], dict[str, Any]],
    *,
    continue_on_error: bool = False,
) -> dict[str, Any]:
    if not isinstance(steps, list) or not steps:
        raise ValueError('steps must be a non-empty list')
    if len(steps) > MAX_WORKFLOW_STEPS:
        raise ValueError(f'workflow supports at most {MAX_WORKFLOW_STEPS} steps')

    started = time.monotonic()
    results: list[dict[str, Any]] = []
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            raise ValueError(f'step {index} must be an object')
        action = str(step.get('action') or '').strip()
        if not action:
            raise ValueError(f'step {index} is missing action')
        arguments = step.get('arguments') or {}
        if not isinstance(arguments, dict):
            raise ValueError(f'step {index} arguments must be an object')
        step_started = time.monotonic()
        try:
            result = dispatch(action, arguments)
        except Exception as exc:
            result = {'ok': False, 'code': 'TOOL_ERROR', 'error': str(exc)}
        if not isinstance(result, dict):
            result = {
                'ok': False,
                'code': 'TOOL_ERROR',
                'error': f'action returned {type(result).__name__}, expected object',
            }
        item = {
            'index': index,
            'action': action,
            'ok': bool(result.get('ok')),
            'elapsed_ms': int((time.monotonic() - step_started) * 1000),
            'result': result,
        }
        results.append(item)
        if not item['ok'] and not continue_on_error:
            break

    completed = len(results) == len(steps)
    ok = completed and all(item['ok'] for item in results)
    return {
        'ok': ok,
        'completed': completed,
        'requested_steps': len(steps),
        'executed_steps': len(results),
        'elapsed_ms': int((time.monotonic() - started) * 1000),
        'results': results,
    }
