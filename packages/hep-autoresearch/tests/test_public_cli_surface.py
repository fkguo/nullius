import unittest


def _src_root():
    from pathlib import Path

    return Path(__file__).resolve().parents[1] / "src"


class TestPublicCliSurface(unittest.TestCase):
    def _run_public_cli(self, argv: list[str]) -> tuple[int, str, str]:
        import sys
        from contextlib import redirect_stderr, redirect_stdout
        from io import StringIO

        src_root = str(_src_root())
        added_path = False
        if src_root not in sys.path:
            sys.path.insert(0, src_root)
            added_path = True

        from hep_autoresearch.cli import main as cli_main

        argv0 = list(sys.argv)
        try:
            sys.argv = list(argv)
            buf_out, buf_err = StringIO(), StringIO()
            with redirect_stdout(buf_out), redirect_stderr(buf_err):
                rc = int(cli_main())
            return rc, buf_out.getvalue(), buf_err.getvalue()
        finally:
            sys.argv = argv0
            if added_path:
                try:
                    sys.path.remove(src_root)
                except ValueError:
                    pass

    def test_help_hides_retired_public_lifecycle_verbs(self) -> None:
        rc, out, err = self._run_public_cli(["hepar", "--help"])
        self.assertEqual(rc, 0)
        self.assertEqual(err, "")
        self.assertNotIn(" init ", out)
        self.assertNotIn(" status ", out)
        self.assertNotIn(" pause ", out)
        self.assertNotIn(" resume ", out)
        self.assertNotIn(" approve ", out)
        self.assertNotIn(" export ", out)
        self.assertIn("run", out)
        self.assertIn("doctor", out)
        self.assertIn("bridge", out)

    def test_public_cli_rejects_retired_lifecycle_surfaces(self) -> None:
        for command in ("init", "status", "export"):
            rc, _, err = self._run_public_cli(["hepar", command])
            self.assertEqual(rc, 2)
            self.assertIn("invalid choice", err)
            self.assertIn(command, err)


if __name__ == "__main__":
    unittest.main()
