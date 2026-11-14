import subprocess

from orchestrator.runtime.summaries import project_name


def _git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def test_repo_name_from_remote_and_subfolders_share_it(tmp_path):
    repo = tmp_path / "checkout"
    (repo / "pkg" / "src").mkdir(parents=True)
    _git("init", "-q", cwd=repo)
    _git("remote", "add", "origin", "git@github.com:acme/widget-factory.git", cwd=repo)
    assert project_name(str(repo)) == "widget-factory"
    assert project_name(str(repo / "pkg" / "src")) == "widget-factory"


def test_https_remote_without_suffix(tmp_path):
    _git("init", "-q", cwd=tmp_path)
    _git("remote", "add", "origin", "https://github.com/acme/plain-repo", cwd=tmp_path)
    assert project_name(str(tmp_path)) == "plain-repo"


def test_repo_without_remote_uses_repo_folder(tmp_path):
    repo = tmp_path / "local-only"
    (repo / "sub").mkdir(parents=True)
    _git("init", "-q", cwd=repo)
    assert project_name(str(repo / "sub")) == "local-only"


def test_plain_and_missing_folders_use_basename(tmp_path):
    plain = tmp_path / "notes"
    plain.mkdir()
    assert project_name(str(plain)) == "notes"
    assert project_name(str(tmp_path / "gone")) == "gone"
