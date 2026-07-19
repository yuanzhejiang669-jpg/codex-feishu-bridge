import multiprocessing
import tempfile
import time
import unittest
from pathlib import Path

from router_file_lock import interprocess_file_lock


def hold_lock(path: str, ready: multiprocessing.Queue) -> None:
    with interprocess_file_lock(path):
        ready.put(True)
        time.sleep(0.5)


class RouterFileLockTest(unittest.TestCase):
    def test_excludes_another_process_and_recovers_after_exit(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            target = str(Path(root) / "state.json")
            ready = multiprocessing.Queue()
            process = multiprocessing.Process(target=hold_lock, args=(target, ready))
            process.start()
            self.assertTrue(ready.get(timeout=5))
            with self.assertRaises(TimeoutError):
                with interprocess_file_lock(target, timeout=0.1):
                    pass
            process.join(timeout=5)
            self.assertEqual(0, process.exitcode)
            with interprocess_file_lock(target, timeout=0.2):
                pass


if __name__ == "__main__":
    unittest.main()
