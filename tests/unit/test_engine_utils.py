"""Unit tests for pure helpers in viewer.engine: loop-interval parsing (clamped)
and SKILL.md/command frontmatter description extraction."""
from viewer.engine import frontmatter_description, parse_interval


class TestParseInterval:
    def test_units(self):
        assert parse_interval("30s") == 30
        assert parse_interval("5m") == 300
        assert parse_interval("2h") == 7200
        assert parse_interval("90") == 90  # plain seconds

    def test_clamped_to_bounds(self):
        assert parse_interval("1s") == 30       # min 30
        assert parse_interval("10s") == 30
        assert parse_interval("100h") == 86400  # max 24h

    def test_invalid_returns_none(self):
        assert parse_interval("abc") is None
        assert parse_interval("5x") is None
        assert parse_interval("") is None


class TestFrontmatterDescription:
    def test_plain(self, tmp_path):
        p = tmp_path / "SKILL.md"
        p.write_text("---\nname: x\ndescription: Does a thing\n---\nbody")
        assert frontmatter_description(str(p)) == "Does a thing"

    def test_quoted(self, tmp_path):
        p = tmp_path / "s.md"
        p.write_text('---\ndescription: "Quoted desc"\n---\n')
        assert frontmatter_description(str(p)) == "Quoted desc"

    def test_folded_block_scalar(self, tmp_path):
        p = tmp_path / "s.md"
        p.write_text("---\ndescription: >-\n  Folded line here\n---\n")
        assert frontmatter_description(str(p)) == "Folded line here"

    def test_no_frontmatter(self, tmp_path):
        p = tmp_path / "x.md"
        p.write_text("no frontmatter here\n")
        assert frontmatter_description(str(p)) == ""

    def test_missing_description(self, tmp_path):
        p = tmp_path / "s.md"
        p.write_text("---\nname: only-name\n---\n")
        assert frontmatter_description(str(p)) == ""
