"""Unit tests for the input guards that feed shell/git commands and secret
storage: gitops branch/repo/path validation and hostenv key validation."""
import shlex

from viewer.gitops import REPO_RE, _q_path, valid_branch
from viewer.hostenv import valid_key


class TestValidBranch:
    def test_accepts_normal_names(self):
        for b in ("main", "feature/x", "release-1.2", "a_b.c", "user/fix-123"):
            assert valid_branch(b), b

    def test_rejects_dangerous_or_malformed(self):
        for b in ("", "-x", "/x", ".x", "x/", "x.", "x.lock",
                  "a..b", "a//b", "x@{0}", "a b", "a;b", "a$(x)b"):
            assert not valid_branch(b), b


class TestRepoRe:
    def test_accepts_owner_repo(self):
        assert REPO_RE.match("owner/repo")
        assert REPO_RE.match("Owner_1/repo.js-x")

    def test_rejects_malformed(self):
        for r in ("owner", "owner/repo/extra", "owner/re po", "owner/", "/repo", "a/b/c"):
            assert not REPO_RE.match(r), r


class TestQPath:
    def test_home_stays_expandable(self):
        assert _q_path("~") == '"$HOME"'
        assert _q_path("~/proj") == '"$HOME"' + shlex.quote("/proj")

    def test_plain_path_quoted(self):
        assert _q_path("/tmp/x") == shlex.quote("/tmp/x")

    def test_injection_is_inert(self):
        q = _q_path("/tmp/a b; rm -rf /")
        # shlex.quote single-quotes the whole thing so metacharacters can't run.
        assert q.startswith("'") and q.endswith("'") and "rm -rf" in q


class TestValidKey:
    def test_accepts_env_var_names(self):
        for k in ("GH_TOKEN", "_x", "A1", "path_2"):
            assert valid_key(k), k

    def test_rejects_bad_names(self):
        for k in ("", "1BAD", "BAD-KEY", "GH TOKEN", "a.b", None):
            assert not valid_key(k), k
