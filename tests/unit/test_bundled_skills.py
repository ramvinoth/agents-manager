"""Unit tests for the skills that ship with agents-manager.

The promise this file defends: everyone who installs agents-manager gets the
bundled skills, every upgrade can improve them, and no upgrade ever destroys a
skill the user wrote or edited. Those three are in tension, so each is a test.

Hermetic — every case installs into a tmp_path, never into the real
~/.claude/skills.
"""
import json

import pytest

from viewer import skills


@pytest.fixture
def scope(tmp_path, monkeypatch):
    """A project-scoped skills base inside tmp_path, used as the install target.

    project scope takes an explicit cwd, so no monkeypatching of Path.home() is
    needed and the real home directory is never a possible target of a bug in
    the code under test.
    """
    return {"scope": "project", "cwd": str(tmp_path)}


def _target(cwd, name):
    return skills.skills_base("project", cwd) / name / "SKILL.md"


class TestBundledContents:
    def test_the_response_structure_skill_ships(self):
        # This is the skill the product's response quality depends on. If it
        # stops shipping, every installed environment silently loses it.
        assert "anchor-original-intent" in skills.bundled_names()

    def test_every_bundled_skill_has_frontmatter_with_its_own_name(self):
        # Claude Code matches a skill by the `name:` in its frontmatter, not by
        # its directory. A mismatch installs a skill that never triggers.
        for name in skills.bundled_names():
            text = (skills.BUNDLED_DIR / name / "SKILL.md").read_text()
            assert text.startswith("---\n"), name
            head = text.split("---", 2)[1]
            assert f"name: {name}" in head, name
            assert "description:" in head, name


class TestInstall:
    def test_a_fresh_install_writes_every_bundled_skill(self, scope):
        results = skills.install_bundled(**scope)
        assert results, "nothing was installed"
        for name, action in results:
            assert action == "installed", (name, action)
            assert _target(scope["cwd"], name).exists()

    def test_installed_content_is_byte_identical_to_the_bundled_copy(self, scope):
        skills.install_bundled(**scope)
        for name in skills.bundled_names():
            assert _target(scope["cwd"], name).read_text() == (
                skills.BUNDLED_DIR / name / "SKILL.md"
            ).read_text()

    def test_install_shows_up_in_list_skill_names(self, scope):
        skills.install_bundled(**scope)
        listed = skills.list_skill_names(**scope)
        for name in skills.bundled_names():
            assert name in listed

    def test_running_twice_is_a_no_op(self, scope):
        skills.install_bundled(**scope)
        for name, action in skills.install_bundled(**scope):
            assert action == "current", (name, action)


class TestUpgrade:
    def test_an_unmodified_skill_is_refreshed_when_the_bundle_changes(self, scope):
        # The capability an upgrade needs: ship a better version and have it
        # actually reach an environment that already installed the old one.
        name = "anchor-original-intent"
        skills.install_bundled(**scope)
        target = _target(scope["cwd"], name)
        # Simulate "the bundle moved on" by rewinding what is on disk to an
        # older text AND rewinding the receipt to match, which is exactly the
        # state an older install left behind.
        old = "---\nname: anchor-original-intent\ndescription: old\n---\nold body\n"
        target.write_text(old)
        (target.parent / skills.RECEIPT_NAME).write_text(
            json.dumps({"sha256": skills._digest(old), "name": name}) + "\n"
        )
        actions = dict(skills.install_bundled(**scope))
        assert actions[name] == "updated"
        assert target.read_text() == (skills.BUNDLED_DIR / name / "SKILL.md").read_text()

    def test_a_locally_edited_skill_is_never_overwritten(self, scope):
        # The user's edit outranks the bundle. Silently replacing it would be
        # the worst failure this module can have.
        name = "anchor-original-intent"
        skills.install_bundled(**scope)
        target = _target(scope["cwd"], name)
        mine = target.read_text() + "\n## My own addition\nKeep this.\n"
        target.write_text(mine)
        actions = dict(skills.install_bundled(**scope))
        assert actions[name] == "kept (edited locally)"
        assert target.read_text() == mine

    def test_a_users_own_skill_sharing_a_bundled_name_is_never_touched(self, scope):
        # No receipt means we did not write it, so it is not ours to replace —
        # even though the name collides.
        name = "anchor-original-intent"
        target = _target(scope["cwd"], name)
        target.parent.mkdir(parents=True)
        target.write_text("mine, written by hand\n")
        actions = dict(skills.install_bundled(**scope))
        assert actions[name] == "kept (not ours)"
        assert target.read_text() == "mine, written by hand\n"

    def test_a_corrupt_receipt_is_treated_as_not_ours(self, scope):
        # Failing closed: an unreadable receipt must not license an overwrite.
        name = "anchor-original-intent"
        skills.install_bundled(**scope)
        target = _target(scope["cwd"], name)
        (target.parent / skills.RECEIPT_NAME).write_text("{not json")
        target.write_text("user content\n")
        actions = dict(skills.install_bundled(**scope))
        assert actions[name] == "kept (not ours)"
        assert target.read_text() == "user content\n"


class TestBootstrapWiring:
    def test_bootstrap_calls_install_bundled(self, monkeypatch):
        # The install path is bootstrap, which the container converge script
        # runs on every bundle it installs. If this call is dropped, bundled
        # skills stop reaching environments and nothing else would notice.
        from viewer import bootstrap

        calls = []
        monkeypatch.setattr(bootstrap.db, "init_db", lambda: None)
        monkeypatch.setattr(bootstrap.db, "board_columns_list", lambda: [])
        monkeypatch.setattr(bootstrap.db, "employee_list", lambda: [{"name": "Ram"}])
        monkeypatch.setattr(bootstrap.skills, "install_bundled",
                            lambda *a, **k: calls.append(1) or [("x", "installed")])
        report = bootstrap.bootstrap()
        assert calls, "bootstrap did not install the bundled skills"
        assert any("skill x: installed" in line for line in report)
