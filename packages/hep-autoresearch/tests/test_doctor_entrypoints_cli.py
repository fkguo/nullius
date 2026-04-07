import unittest


def _src_root():
    from pathlib import Path

    return Path(__file__).resolve().parents[1] / "src"


class TestDoctorEntrypointSurfaceRetired(unittest.TestCase):
    def _run_cli(self, argv: list[str]) -> tuple[int, str, str]:
        import sys
        from contextlib import redirect_stderr, redirect_stdout
        from io import StringIO

        src_root = str(_src_root())
        added_path = False
        if src_root not in sys.path:
            sys.path.insert(0, src_root)
            added_path = True

        from hep_autoresearch.orchestrator_cli import main as cli_main

        argv0 = list(sys.argv)
        try:
            sys.argv = list(argv)
            buf_out, buf_err = StringIO(), StringIO()
            with redirect_stdout(buf_out), redirect_stderr(buf_err):
                try:
                    rc = int(cli_main())
                except SystemExit as exc:
                    rc = int(exc.code)
            return rc, buf_out.getvalue(), buf_err.getvalue()
        finally:
            sys.argv = argv0
            if added_path:
                try:
                    sys.path.remove(src_root)
                except ValueError:
                    pass

    def test_doctor_entrypoint_flags_no_longer_reachable(self) -> None:
        rc, out, err = self._run_cli(
            [
                "hepar",
                "--project-root",
                ".",
                "doctor",
                "--json",
                "--strict-entrypoints",
            ]
        )
        self.assertEqual(rc, 2, msg=out + err)
        self.assertIn("invalid choice", out + err)
        self.assertIn("doctor", out + err)


if __name__ == "__main__":
    unittest.main()
