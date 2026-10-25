import sys

from engine.jobs import JobControl


def test_launcher_does_not_import_from_untrusted_cwd(tmp_path):
    marker = tmp_path / "shadow-imported"
    for name in ("threading", "subprocess"):
        (tmp_path / (name + ".py")).write_text(
            "from pathlib import Path\nPath(%r).touch()\n" % str(marker)
        )
    result = JobControl().run(
        [sys.executable, "-I", "-c", "print('command ran')"],
        tmp_path, tmp_path / "output.log", 10,
    )
    assert result == 0
    assert "command ran" in (tmp_path / "output.log").read_text()
    assert not marker.exists()
