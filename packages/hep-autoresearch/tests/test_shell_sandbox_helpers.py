import os
import stat
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestShellSandboxHelpers(unittest.TestCase):
    def test_copy_staged_outputs_copies_and_skips(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.adapters.shell import _copy_staged_outputs

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            staged = root / "staged"
            dest = root / "dest"
            staged.mkdir()
            dest.mkdir()

            (staged / "a.txt").write_text("a", encoding="utf-8")
            (staged / "manifest.json").write_text("{}", encoding="utf-8")  # SSOT skip
            (staged / "logs").mkdir()
            (staged / "logs" / "x.txt").write_text("log", encoding="utf-8")  # logs/ skip
            (staged / "nested").mkdir()
            (staged / "nested" / "b.txt").write_text("b", encoding="utf-8")

            copied_n, copied = _copy_staged_outputs(staged_dir=staged, dest_dir=dest)

            self.assertEqual(copied_n, 2)
            self.assertIn("a.txt", copied)
            self.assertIn("nested/b.txt", copied)
            self.assertTrue((dest / "a.txt").exists())
            self.assertTrue((dest / "nested" / "b.txt").exists())
            self.assertFalse((dest / "manifest.json").exists())
            self.assertFalse((dest / "logs" / "x.txt").exists())

    def test_copy_staged_outputs_refuses_escape_via_symlink_dir(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.adapters.shell import _copy_staged_outputs

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            staged = root / "staged"
            dest = root / "dest"
            outside = root / "outside"
            staged.mkdir()
            dest.mkdir()
            outside.mkdir()
            (outside / "secret.txt").write_text("secret", encoding="utf-8")

            # Symlinked directory that could escape staged_dir if traversed.
            (staged / "escape").symlink_to(outside, target_is_directory=True)

            copied_n, copied = _copy_staged_outputs(staged_dir=staged, dest_dir=dest)
            self.assertEqual(copied_n, 0)
            self.assertEqual(copied, [])
            self.assertFalse((dest / "escape" / "secret.txt").exists())
            self.assertFalse((dest / "secret.txt").exists())

    def test_make_tree_read_only_and_writable(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.adapters.shell import _make_tree_read_only, _make_tree_writable

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            d = root / "d"
            d.mkdir()
            f = d / "f.txt"
            f.write_text("x", encoding="utf-8")

            os.chmod(d, stat.S_IRWXU)
            os.chmod(f, stat.S_IRUSR | stat.S_IWUSR)

            _make_tree_read_only(root)
            self.assertEqual((d.stat().st_mode & stat.S_IWUSR) != 0, False)
            self.assertEqual((f.stat().st_mode & stat.S_IWUSR) != 0, False)

            _make_tree_writable(root)
            self.assertEqual((d.stat().st_mode & stat.S_IWUSR) != 0, True)
            self.assertEqual((f.stat().st_mode & stat.S_IWUSR) != 0, True)
