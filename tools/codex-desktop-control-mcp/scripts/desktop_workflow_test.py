from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from workflow_runtime import compare_images, execute_workflow  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    before = Image.new('RGB', (100, 80), 'white')
    after = before.copy()
    ImageDraw.Draw(after).rectangle([20, 10, 39, 29], fill='black')
    difference = compare_images(before, after)
    require(difference['changed'] is True, f'change was not detected: {difference}')
    require(difference['changed_bbox'] == [20, 10, 40, 30], f'unexpected change bbox: {difference}')
    require(abs(difference['changed_ratio'] - 0.05) < 0.001, f'unexpected change ratio: {difference}')
    resized = compare_images(before, Image.new('RGB', (50, 40), 'white'))
    require(resized['resized_for_comparison'] is True, f'resized comparison was not disclosed: {resized}')

    calls: list[tuple[str, dict]] = []

    def dispatch(action: str, arguments: dict):
        calls.append((action, arguments))
        if action == 'fail':
            return {'ok': False, 'error': 'synthetic'}
        return {'ok': True, 'value': arguments.get('value')}

    stopped = execute_workflow([
        {'action': 'first', 'arguments': {'value': 1}},
        {'action': 'fail'},
        {'action': 'third'},
    ], dispatch)
    require(stopped['ok'] is False and stopped['executed_steps'] == 2, f'workflow did not stop: {stopped}')

    continued = execute_workflow([
        {'action': 'first'},
        {'action': 'fail'},
        {'action': 'third'},
    ], dispatch, continue_on_error=True)
    require(continued['executed_steps'] == 3 and continued['ok'] is False, f'workflow did not continue: {continued}')

    try:
        execute_workflow([], dispatch)
    except ValueError:
        pass
    else:
        raise AssertionError('empty workflow should fail validation')

    invalid_result = execute_workflow([{'action': 'invalid'}], lambda _action, _arguments: None)
    require(invalid_result['results'][0]['result']['code'] == 'TOOL_ERROR', f'non-object action result was not contained: {invalid_result}')

    if sys.platform == 'win32':
        import windows_input

        original_move = windows_input.move_mouse
        original_mouse_event = windows_input.win32api.mouse_event
        mouse_events: list[int] = []
        move_count = 0

        def failing_move(_x: int, _y: int, **_kwargs) -> None:
            nonlocal move_count
            move_count += 1
            if move_count > 1:
                raise RuntimeError('synthetic drag interruption')

        try:
            windows_input.move_mouse = failing_move
            windows_input.win32api.mouse_event = lambda event, *_args: mouse_events.append(event)
            try:
                windows_input.drag(1, 1, 2, 2)
            except RuntimeError:
                pass
            else:
                raise AssertionError('interrupted drag should propagate its error')
            expected_up = windows_input.win32con.MOUSEEVENTF_LEFTUP
            require(mouse_events and mouse_events[-1] == expected_up, f'interrupted drag did not release the mouse button: {mouse_events}')
        finally:
            windows_input.move_mouse = original_move
            windows_input.win32api.mouse_event = original_mouse_event

    print('OK: workflow execution and visual change detection succeeded.')


if __name__ == '__main__':
    main()
