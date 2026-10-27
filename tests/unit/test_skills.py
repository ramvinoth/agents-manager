"""viewer.skills — the skill library as an agent (skill_list / skill_read) sees it.

Disk is the truth for what exists; the ledger only adds provenance. These tests
pin the three join cases and the frontmatter description read, against a temp
skills base so no test touches ~/.claude/skills.
"""
from viewer import skills


def _write(base, name, description):
    d = base / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\nbody\n")


def test_read_description_from_frontmatter(tmp_path):
    _write(tmp_path, "deploy-x", "When shipping X to prod.")
    assert skills.read_description(tmp_path / "deploy-x" / "SKILL.md") == \
        "When shipping X to prod."


def test_read_description_absent_or_unreadable(tmp_path):
    (tmp_path / "plain.md").write_text("no frontmatter here")
    assert skills.read_description(tmp_path / "plain.md") == ""
    assert skills.read_description(tmp_path / "does-not-exist.md") == ""


def test_library_joins_disk_and_ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(skills, "skills_base", lambda scope="user", cwd=None: tmp_path)
    _write(tmp_path, "learned", "A learned procedure.")
    _write(tmp_path, "handwritten", "Installed by the owner.")
    (tmp_path / "not-a-skill").mkdir()  # no SKILL.md → not a skill
    ledger = [
        {"id": 1, "name": "learned", "status": "active", "origin_session": "s1"},
        {"id": 2, "name": "gone", "status": "active", "origin_session": "s2"},
    ]
    rows = {r["name"]: r for r in skills.library(ledger)}
    assert set(rows) == {"learned", "handwritten", "gone"}
    # on disk + ledger: provenance kept, description from the file, real path
    assert rows["learned"]["origin_session"] == "s1"
    assert rows["learned"]["description"] == "A learned procedure."
    assert rows["learned"]["path"].endswith("learned/SKILL.md")
    # on disk only: no ledger id, still listed as active (the CLI will load it)
    assert "id" not in rows["handwritten"]
    assert rows["handwritten"]["status"] == "active"
    assert rows["handwritten"]["description"] == "Installed by the owner."
    # ledger only: the file was deleted — say so instead of vouching for it
    assert rows["gone"]["status"] == "missing"
    assert rows["gone"]["id"] == 2


def test_read_description_yaml_block_scalar(tmp_path):
    p = tmp_path / "SKILL.md"
    p.write_text("---\nname: h\ndescription: >\n  Remove signs of AI writing.\n"
                 "  Use when editing text.\nallowed-tools: Read\n---\nbody\n")
    assert skills.read_description(p) == \
        "Remove signs of AI writing. Use when editing text."
