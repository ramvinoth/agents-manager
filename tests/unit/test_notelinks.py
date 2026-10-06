"""notelinks — Obsidian-style [[links]] and #tags derived from note bodies:
parsing, resolution, the graph, rename rewriting and the vault export. Pure."""
from viewer import notelinks as nl


def _n(id, title, body="", project_id=1, archived=False, updated_at=0, **kw):
    return {"id": id, "title": title, "body": body, "project_id": project_id,
            "archived": archived, "updated_at": updated_at, "kind": "note", **kw}


def test_parse_links_headings_aliases_and_tags():
    p = nl.parse("See [[Plan]] and [[Plan#Risks|the risks]] #idea #Big-Bet\n[[#local]] [[]]")
    assert [(l["target"], l["heading"], l["alias"]) for l in p["links"]] == [
        ("Plan", "", ""), ("Plan", "Risks", "the risks")]
    assert p["tags"] == ["idea", "big-bet"]
    assert p["links"][0]["context"].startswith("See [[Plan]]")


def test_code_is_never_a_link_or_tag():
    body = "`[[Nope]] #nope`\n```\n[[Nope]] #nope\n```\n~~~\n#nope\n~~~\n[[Yes]]"
    p = nl.parse(body)
    assert [l["target"] for l in p["links"]] == ["Yes"] and p["tags"] == []


def test_headings_numbers_and_urls_are_not_tags():
    p = nl.parse("# Heading\nissue #42 and a#b url http://x.com/#frag (#ok) #trail/")
    assert p["tags"] == ["ok", "trail"]


def test_index_resolves_per_project_with_deterministic_tiebreak():
    notes = [_n(1, "Plan", archived=True, updated_at=9), _n(2, "plan", updated_at=1),
             _n(3, " PLAN ", updated_at=5), _n(4, "Plan", project_id=2)]
    idx = nl.index(notes)
    assert idx[1]["plan"] == 3 and idx[2]["plan"] == 4


def test_graph_edges_ghosts_tags_and_archived_targets():
    notes = [_n(1, "A", "[[B]] [[B]] [[B#x]] [[Ghost]] #t"), _n(2, "B", "[[A]] #t #u"),
             _n(3, "Old", archived=True), _n(4, "C", "[[Old]]"), _n(5, "Shelved", "[[A]]", archived=True)]
    g = nl.graph(notes)
    assert {(e["source"], e["target"], e["heading"]) for e in g["edges"]} == {
        (1, 2, ""), (1, 2, "x"), (2, 1, ""), (4, 3, "")}
    assert g["ghosts"] == [{"title": "Ghost", "project_id": 1, "from": [1]}]
    assert {n["id"] for n in g["nodes"]} == {1, 2, 3, 4}   # 5 archived + unlinked
    assert g["tags"][0] == {"tag": "t", "count": 2}
    assert g["index"]["1"]["b"] == 2


def test_rename_keeps_heading_alias_and_code():
    body = "[[Old]] [[old#H|see]] `[[Old]]`\n```\n[[Old]]\n```\n[[Older]]"
    out = nl.rename(body, "Old", "New Name")
    assert out == "[[New Name]] [[New Name#H|see]] `[[Old]]`\n```\n[[Old]]\n```\n[[Older]]"
    assert nl.rename(body, "nothing", "x") is body
    for bad in ("", "old", "a ]] b"):
        assert nl.rename(body, "Old", bad) is body


def test_vault_names_files_and_relinks_where_names_differ():
    notes = [_n(1, "A/B: plan", "#idea", created_at=0, updated_at=0, pinned=True),
             _n(2, "Dup", "[[a/b: plan|x]] [[A/B: plan#H]] [[Dup]]"),
             _n(3, "dup", "", archived=True),
             _n(4, "", "First line here")]
    v = nl.vault(notes)
    assert set(v) == {"A B plan.md", "Dup.md", "Archive/dup 2.md", "First line here.md"}
    assert "[[A B plan|x]] [[A B plan#H|A/B: plan#H]] [[Dup]]" in v["Dup.md"]
    front = v["A B plan.md"].split("---")[1]
    assert 'aliases: ["A/B: plan"]' in front and 'tags: ["idea"]' in front and "pinned: true" in front


def test_vault_spanning_projects_uses_one_folder_each():
    v = nl.vault([_n(1, "A"), _n(2, "A", project_id=2), _n(3, "A", project_id=None)],
                 {1: "Same", 2: "Same"})
    assert set(v) == {"Same/A.md", "Same 2/A 2.md", "No project/A 3.md"}
