"""Tests for viewer.marketplace (pure, fake fetch) and skills.write_bundle.
No network: every source answer is a canned registry/GitHub shape."""
import json

import pytest

from viewer import marketplace as M, skills

NPM = {"name": "io.github.acme/notes-mcp", "version": "1.2.0", "description": "Notes",
       "repository": {"url": "https://github.com/acme/notes-mcp"},
       "packages": [{"registryType": "npm", "identifier": "@acme/notes-mcp", "version": "1.2.0",
                     "transport": {"type": "stdio"},
                     "packageArguments": [{"type": "positional", "value": "--stdio"}],
                     "environmentVariables": [{"name": "NOTES_KEY", "isRequired": True, "isSecret": True},
                                              {"name": "NOTES_DIR"}]}]}
REMOTE = {"name": "com.example/remote", "version": "2.0.0",
          "remotes": [{"type": "streamable-http", "url": "https://mcp.example.com/mcp",
                       "headers": [{"name": "Authorization", "isRequired": True, "isSecret": True}]}],
          "packages": [{"registryType": "npm", "identifier": "x", "version": "1", "transport": {"type": "stdio"}}]}
OCI = {"name": "io.github.acme/docker-only", "version": "1",
       "packages": [{"registryType": "oci", "identifier": "ghcr.io/acme/x:1", "transport": {"type": "stdio"}}]}


def fetcher(routes):
    def fetch(url):
        for k, v in routes.items():
            if k in url:
                return v if isinstance(v, bytes) else json.dumps(v).encode()
        raise AssertionError(f"unexpected fetch {url}")
    return fetch


def test_npm_package_becomes_a_pinned_npx_stdio_entry():
    cfg = M.mcp_config(NPM, {"NOTES_KEY": " k ", "NOTES_DIR": ""})
    assert cfg == {"type": "stdio", "command": "npx", "args": ["-y", "@acme/notes-mcp@1.2.0", "--stdio"],
                   "env": {"NOTES_KEY": "k"}}


def test_pypi_package_runs_through_uvx_pinned():
    s = {"name": "a/b", "packages": [{"registryType": "pypi", "identifier": "b-mcp", "version": "0.3",
                                      "transport": {"type": "stdio"}}]}
    assert M.mcp_config(s, {}) == {"type": "stdio", "command": "uvx", "args": ["b-mcp==0.3"]}


def test_hosted_remote_wins_over_a_package_and_carries_headers():
    assert M.mcp_config(REMOTE, {"Authorization": "Bearer t"}) == {
        "type": "http", "url": "https://mcp.example.com/mcp", "headers": {"Authorization": "Bearer t"}}


def test_required_input_missing_is_refused():
    with pytest.raises(M.MarketError, match="NOTES_KEY"):
        M.mcp_config(NPM, {})


def test_docker_only_is_listed_but_not_installable():
    assert M.mcp_entry(OCI)["install"] is None
    with pytest.raises(M.MarketError, match="Docker"):
        M.mcp_config(OCI, {})


def test_templated_remote_url_is_not_installable():
    s = {"name": "a/b", "remotes": [{"type": "streamable-http", "url": "https://{tenant}.x.com/mcp"}]}
    assert M.mcp_entry(s)["install"] is None


def test_search_maps_entries_and_cursor():
    fetch = fetcher({"servers?": {"servers": [{"server": NPM}, {"server": OCI}], "metadata": {"nextCursor": "c2"}}})
    page = M.mcp_search(fetch, "notes")
    assert page["cursor"] == "c2"
    a, b = page["items"]
    assert (a["id"], a["publisher"], a["install"], a["title"]) == ("io.github.acme/notes-mcp", "io.github.acme", "npm", "notes-mcp")
    assert [i["name"] for i in a["inputs"]] == ["NOTES_KEY", "NOTES_DIR"] and a["inputs"][0]["secret"]
    assert b["install"] is None


def test_lookup_quotes_the_name_and_config_name_is_safe():
    seen = []
    M.mcp_lookup(lambda u: seen.append(u) or json.dumps({"server": NPM}).encode(), "io.github.acme/notes-mcp")
    assert seen[0].endswith("/servers/io.github.acme%2Fnotes-mcp/versions/latest")
    assert M.config_name(NPM) == "notes-mcp"
    assert M.config_name({"name": "a/we ird.name"}) == "we-ird-name"


def test_unreachable_source_is_a_502():
    def boom(url):
        raise OSError("down")
    with pytest.raises(M.MarketError) as e:
        M.mcp_search(boom)
    assert e.value.status == 502


TREE = {"tree": [
    {"path": "skills/pdf", "type": "tree"},
    {"path": "skills/pdf/SKILL.md", "type": "blob", "size": 10},
    {"path": "skills/pdf/scripts/x.py", "type": "blob", "size": 5},
    {"path": "skills/README.md", "type": "blob", "size": 1},
    {"path": "skills/nomd/notes.txt", "type": "blob", "size": 1},
]}


@pytest.fixture(autouse=True)
def _fresh_cache():
    M._cache.clear()


def test_skills_catalog_lists_dirs_with_a_skill_md_and_reads_frontmatter():
    fetch = fetcher({"git/trees": TREE, "pdf/SKILL.md": b"---\nname: pdf\ndescription: \"PDF work\"\nlicense: MIT\n---\nbody"})
    [s] = M.skills_catalog(fetch)
    assert (s["id"], s["description"], s["license"], s["files"]) == ("pdf", "PDF work", "MIT", 2)


def test_skill_bundle_fetches_every_file_relative_to_the_skill():
    fetch = fetcher({"git/trees": TREE, "SKILL.md": b"md", "x.py": b"py"})
    assert M.skill_bundle(fetch, "pdf") == {"SKILL.md": b"md", "scripts/x.py": b"py"}
    with pytest.raises(M.MarketError) as e:
        M.skill_bundle(fetch, "nomd")
    assert e.value.status == 404


def test_oversize_skill_is_refused():
    big = {"tree": [{"path": "skills/big/SKILL.md", "type": "blob", "size": M.SKILL_MAX_BYTES + 1}]}
    with pytest.raises(M.MarketError) as e:
        M.skill_bundle(fetcher({"git/trees": big}), "big")
    assert e.value.status == 413


def test_write_bundle_replaces_and_refuses_traversal(tmp_path):
    skills.write_bundle("pdf", {"SKILL.md": b"v1", "old.py": b"x"}, scope="project", cwd=tmp_path)
    p = skills.write_bundle("pdf", {"SKILL.md": b"v2", "scripts/a.py": b"y"}, scope="project", cwd=tmp_path)
    d = p.parent
    assert p.read_bytes() == b"v2" and (d / "scripts/a.py").exists() and not (d / "old.py").exists()
    with pytest.raises(ValueError, match="Unsafe"):
        skills.write_bundle("pdf", {"SKILL.md": b"v3", "../evil": b"z"}, scope="project", cwd=tmp_path)
    assert p.read_bytes() == b"v2", "a refused bundle must not delete the installed one"
    with pytest.raises(ValueError, match="SKILL.md"):
        skills.write_bundle("pdf", {"a": b""}, scope="project", cwd=tmp_path)
