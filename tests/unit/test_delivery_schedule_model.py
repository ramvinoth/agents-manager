"""Model-check the delivery reminder stale-revision safety contract.

The TLA+ model deliberately has an unsafe configuration: a schedule can be
rescheduled after a reminder exists and that old reminder can still be claimed
and delivered.  The fixed configuration is the repository contract: mutation
cancels old pending/claimed rows and finalization rechecks the schedule revision
and terminal status while it holds the reminder row.

This test keeps the counterexample executable in CI.  It skips rather than
pretending to run the model when a developer machine has no Java/TLC toolchain.
Repository tests exercise the corresponding SQL boundary independently.
"""
from __future__ import annotations

import os
import pathlib
import shutil
import subprocess

import pytest


ROOT = pathlib.Path(__file__).resolve().parents[2]
JAR = pathlib.Path(
    os.environ.get("TLA2TOOLS", "~/.local/share/tla/tla2tools.jar")
).expanduser()


def _tlc(config: str, workdir: pathlib.Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            shutil.which("java"), "-XX:+UseParallelGC", "-cp", str(JAR), "tlc2.TLC",
            "-workers", "1", "-config", config, "-metadir", str(workdir / f"meta-{config}"),
            "DeliverySchedule.tla",
        ],
        cwd=workdir,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


@pytest.fixture(scope="module")
def model_dir(tmp_path_factory: pytest.TempPathFactory) -> pathlib.Path:
    if not shutil.which("java") or not JAR.is_file():
        pytest.skip("TLC not installed (java + tla2tools.jar)")
    destination = tmp_path_factory.mktemp("delivery-tla")
    for name in ("DeliverySchedule.tla", "DeliveryScheduleFixed.cfg", "DeliveryScheduleOriginal.cfg"):
        shutil.copy(ROOT / "formal" / name, destination / name)
    return destination


def test_fixed_model_has_no_stale_or_terminal_delivery(model_dir: pathlib.Path):
    result = _tlc("DeliveryScheduleFixed.cfg", model_dir)
    assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-1000:]
    assert "No error has been found" in result.stdout


def test_unsafe_model_reproduces_the_stale_revision_counterexample(model_dir: pathlib.Path):
    result = _tlc("DeliveryScheduleOriginal.cfg", model_dir)
    output = result.stdout + result.stderr
    assert result.returncode != 0
    assert "Invariant NoStaleOrTerminalDelivery is violated" in output
    # The trace demonstrates why an old reminder must be invalidated at both
    # mutation and delivery-finalization boundaries.
    assert "Reschedule" in output
    assert "Deliver" in output
