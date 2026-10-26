import contextlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest

SCRIPT = os.path.join(
    os.path.dirname(__file__), "..", "skills", "code-review", "scripts", "semantic_commits.py"
)
spec = importlib.util.spec_from_file_location("semantic_commits", SCRIPT)
sc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sc)

ENV = {
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com",
}


def numbered(prefix, n=30):
    return "".join(f"{prefix}{i}\n" for i in range(1, n + 1))


class Fixture(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name
        self.git("init", "-q", "-b", "feature")
        self.write("a.py", numbered("a"))
        self.write("b.py", numbered("b"))
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD")

        self.edit("a.py", 2, "a2 changed")
        self.write("c.py", "def c():\n    return 1\n")
        self.commit("[s1] first stage", "a.py", "c.py")

        self.edit("a.py", 28, "a28 changed")
        self.edit("b.py", 5, "b5 changed")
        self.commit("[s2] second stage", "a.py", "b.py")

        self.edit("b.py", 28, "b28 changed")
        self.write("d.py", "d = 1\n")
        self.commit("[s3] third stage", "b.py", "d.py")
        self.tip = self.git("rev-parse", "HEAD")
        self.tree = self.git("rev-parse", "HEAD^{tree}")

    def git(self, *args, check=True):
        proc = subprocess.run(["git", "-C", self.dir, *args], capture_output=True,
                              text=True, env={**os.environ, **ENV})
        if check:
            self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout.strip()

    def write(self, name, text):
        with open(os.path.join(self.dir, name), "w") as fh:
            fh.write(text)

    def edit(self, name, line, text):
        path = os.path.join(self.dir, name)
        with open(path) as fh:
            lines = fh.readlines()
        lines[line - 1] = text + "\n"
        with open(path, "w") as fh:
            fh.writelines(lines)

    def commit(self, title, *files):
        self.git("add", *files)
        self.git("commit", "-qm", title)

    def run_cmd(self, *args):
        buf, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err):
            code = sc.main(["--repo", self.dir, *args])
        return code, buf.getvalue() + err.getvalue()

    def state(self, name):
        git_dir = self.git("rev-parse", "--absolute-git-dir")
        return os.path.join(git_dir, "code-review", "feature", name)

    def list_units(self):
        code, text = self.run_cmd("list", "--base", self.base)
        self.assertEqual(code, 0, text)
        with open(self.state("units.json")) as fh:
            return json.load(fh), text

    def write_grouping(self, commits):
        with open(self.state("grouping.json"), "w") as fh:
            json.dump({"commits": commits}, fh)

    def by_file(self, data):
        out = {}
        for u in data["units"]:
            out.setdefault(u["file"], []).append(u["id"])
        return out


class ListTest(Fixture):
    def test_units_and_origin(self):
        data, text = self.list_units()
        files = self.by_file(data)
        self.assertEqual(len(files["a.py"]), 2)
        self.assertEqual(len(files["b.py"]), 2)
        self.assertEqual(len(files["c.py"]), 1)
        first_a = next(u for u in data["units"] if u["id"] == files["a.py"][0])
        self.assertEqual([o["title"] for o in first_a["origin"]], ["[s1] first stage"])
        last_b = next(u for u in data["units"] if u["id"] == files["b.py"][1])
        self.assertEqual([o["title"] for o in last_b["origin"]], ["[s3] third stage"])
        self.assertIn("a.py", text)
        self.assertIn("from: [s2] second stage", text)

    def test_detached_head_is_refused(self):
        self.git("checkout", "-q", "--detach")
        code, text = self.run_cmd("list", "--base", self.base)
        self.assertEqual(code, 1)
        self.assertIn("detached", text)


class Grouped(Fixture):
    def group(self, data):
        f = self.by_file(data)
        body = "Technical.\n\n- a file changed\n\n---\n\nPlain."
        return [
            {"title": "a: top change", "body": body, "units": [f["a.py"][0], f["c.py"][0]]},
            {"title": "a: bottom change", "body": body, "units": [f["a.py"][1], f["b.py"][0]]},
            {"title": "b: last change", "body": body, "units": [f["b.py"][1], *[
                u["id"] for u in data["units"] if u["file"] == "d.py"]]},
        ]


class BuildTest(Grouped):

    def test_build_splits_and_merges_hunks(self):
        data, _ = self.list_units()
        self.write_grouping(self.group(data))
        code, text = self.run_cmd("build", "--base", self.base)
        self.assertEqual(code, 0, text)
        self.assertIn("tip tree: identical", text)
        self.assertIn("no invented lines: ok", text)

        self.assertEqual(self.git("rev-parse", "HEAD^{tree}"), self.tree)
        titles = self.git("log", "--reverse", "--format=%s", f"{self.base}..HEAD").split("\n")
        self.assertEqual(titles, ["[c1] a: top change", "[c2] a: bottom change",
                                  "[c3] b: last change"])
        refs = self.git("for-each-ref", "--format=%(refname) %(objectname)",
                        "refs/backup/code-review/feature/")
        self.assertEqual(len(refs.splitlines()), 1)
        self.assertEqual(refs.split()[1], self.tip)
        self.assertEqual(self.git("rev-parse", "refs/code-review/feature"),
                         self.git("rev-parse", "HEAD"))
        self.assertEqual(self.git("status", "--porcelain"), "")
        # the second commit holds a.py's bottom hunk and b.py's first hunk only
        files = self.git("show", "--format=", "--name-only", "HEAD~1").split("\n")
        self.assertEqual(sorted(files), ["a.py", "b.py"])
        self.assertIn("-> [c1]", text)
        self.assertTrue(os.path.exists(self.state("build.log")))

    def test_invalid_grouping_names_the_ids(self):
        data, _ = self.list_units()
        groups = self.group(data)
        groups[0]["units"].append("h99")
        groups[1]["units"].append(groups[2]["units"][0])
        groups[2]["units"].pop(0)
        self.write_grouping(groups)
        code, text = self.run_cmd("build", "--base", self.base)
        self.assertEqual(code, 1)
        self.assertIn("unknown: h99", text)

        groups = self.group(data)
        groups[2]["units"].pop(0)
        self.write_grouping(groups)
        code, text = self.run_cmd("build", "--base", self.base)
        self.assertEqual(code, 1)
        self.assertIn("missing:", text)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.tip)

    def test_invented_line_is_rejected(self):
        data, _ = self.list_units()
        target = next(u for u in data["units"] if u["file"] == "a.py")
        target["patch"] = target["patch"].replace("+a2 changed\n", "+a2 changed\n+invented\n")
        with open(self.state("units.json"), "w") as fh:
            json.dump(data, fh)
        self.write_grouping(self.group(data))
        code, text = self.run_cmd("build", "--base", self.base)
        self.assertEqual(code, 1)
        self.assertTrue("DIFFERENT" in text or "FAILED" in text, text)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.tip)
        self.assertEqual(self.git("for-each-ref", "refs/backup", "refs/code-review"), "")

    def test_moved_tip_is_refused(self):
        data, _ = self.list_units()
        self.write_grouping(self.group(data))
        self.write("e.py", "x\n")
        self.commit("[s4] more", "e.py")
        code, text = self.run_cmd("build", "--base", self.base)
        self.assertEqual(code, 1)
        self.assertIn("moved", text)

    def test_apply_failure_names_commit_and_unit(self):
        data, _ = self.list_units()
        f = self.by_file(data)
        body = "x\n\n---\n\ny"
        target = next(u for u in data["units"] if u["id"] == f["b.py"][1])
        target["patch"] = target["patch"].replace("-b28", "-nope")
        with open(self.state("units.json"), "w") as fh:
            json.dump(data, fh)
        ids = [u["id"] for u in data["units"]]
        self.write_grouping([{"title": "all", "body": body, "units": ids}])
        code, text = self.run_cmd("build", "--base", self.base)
        self.assertEqual(code, 1)
        self.assertIn(f"unit {f['b.py'][1]} does not apply", text)


class SpecialUnitsTest(Fixture):
    def test_rename_and_binary_are_file_level(self):
        self.git("mv", "b.py", "b2.py")
        self.edit("b2.py", 3, "b3 renamed edit")
        with open(os.path.join(self.dir, "img.bin"), "wb") as fh:
            fh.write(bytes(range(256)) * 4)
        self.commit("[s4] rename and binary", "b2.py", "img.bin")
        tip = self.git("rev-parse", "HEAD")
        tree = self.git("rev-parse", "HEAD^{tree}")
        data, _ = self.list_units()
        kinds = {u["file"]: u["kind"] for u in data["units"]}
        self.assertEqual(kinds["b2.py"], "file")
        self.assertEqual(kinds["img.bin"], "file")
        ids = [u["id"] for u in data["units"]]
        self.write_grouping([{"title": "everything", "body": "x\n\n---\n\ny", "units": ids}])
        code, text = self.run_cmd("build", "--base", self.base)
        self.assertEqual(code, 0, text)
        self.assertEqual(self.git("rev-parse", "HEAD^{tree}"), tree)
        self.assertNotEqual(self.git("rev-parse", "HEAD"), tip)


class PreconditionTest(Grouped):
    def build_all(self, *extra):
        data, _ = self.list_units()
        ids = [u["id"] for u in data["units"]]
        self.write_grouping([{"title": "all", "body": "x\n\n---\n\ny", "units": ids}])
        return self.run_cmd("build", "--base", self.base, *extra)

    def test_merge_commit_is_refused(self):
        self.git("checkout", "-q", "-b", "side", self.base)
        self.write("x.py", "x\n")
        self.commit("side work", "x.py")
        self.git("checkout", "-q", "feature")
        self.git("merge", "-q", "--no-ff", "side", "-m", "merge side")
        code, text = self.build_all()
        self.assertEqual(code, 1)
        self.assertIn("not linear", text)
        self.assertEqual(self.git("rev-parse", "--abbrev-ref", "HEAD"), "feature")

    def test_pushed_commit_is_refused(self):
        with tempfile.TemporaryDirectory() as remote:
            subprocess.run(["git", "init", "-q", "--bare", remote], check=True)
            self.git("remote", "add", "origin", remote)
            self.git("push", "-q", "origin", "HEAD~1:refs/heads/feature")
            code, text = self.build_all()
        self.assertEqual(code, 1)
        self.assertIn("on a remote", text)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.tip)

    def test_edited_series_needs_force(self):
        code, text = self.build_all()
        self.assertEqual(code, 0, text)
        self.write("e.py", "x\n")
        self.commit("hand edit", "e.py")
        data, _ = self.list_units()
        ids = [u["id"] for u in data["units"]]
        self.write_grouping([{"title": "all", "body": "x\n\n---\n\ny", "units": ids}])
        code, text = self.run_cmd("build", "--base", self.base)
        self.assertEqual(code, 1)
        self.assertIn("--force", text)
        code, text = self.run_cmd("build", "--base", self.base, "--force")
        self.assertEqual(code, 0, text)


class LintTest(Grouped):
    def build_with(self, command):
        data, _ = self.list_units()
        self.write_grouping(self.group(data))
        return self.run_cmd("build", "--base", self.base, "--lint", command)

    def test_new_finding_on_intermediate_commit_aborts(self):
        code, text = self.build_with("grep -rn 'a28 changed' --include=*.py . ; true")
        self.assertEqual(code, 1)
        self.assertIn("lint FAILED", text)
        self.assertIn("a.py:28", text)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.tip)
        self.assertEqual(self.git("for-each-ref", "refs/backup", "refs/code-review"), "")
        self.assertEqual(self.git("worktree", "list").count("\n"), 0)

    def test_finding_present_at_base_is_accepted(self):
        code, text = self.build_with("grep -rn '^a1$' --include=*.py . ; exit 1")
        self.assertEqual(code, 0, text)
        self.assertIn("[c1] 2 units, lint ok", text)
        self.assertIn("[c3] 2 units, lint ok", text)

    def test_no_lint_is_skipped(self):
        data, _ = self.list_units()
        self.write_grouping(self.group(data))
        code, text = self.run_cmd("build", "--base", self.base)
        self.assertEqual(code, 0, text)
        self.assertIn("lint: skipped", text)
        self.assertIn("[c1] 2 units, lint skipped", text)


class FoldTest(Grouped):
    def test_fix_commit_folds_into_its_target(self):
        data, _ = self.list_units()
        self.write_grouping(self.group(data))
        code, text = self.run_cmd("build", "--base", self.base)
        self.assertEqual(code, 0, text)
        self.edit("a.py", 28, "a28 fixed")
        self.commit("[c2] fix: reword line 28", "a.py")
        tree = self.git("rev-parse", "HEAD^{tree}")
        code, text = self.run_cmd("fold", "--base", self.base)
        self.assertEqual(code, 0, text)
        with open(self.state("grouping.json")) as fh:
            grouping = json.load(fh)["commits"]
        self.assertEqual([c["title"] for c in grouping],
                         ["a: top change", "a: bottom change", "b: last change"])
        data, _ = self.list_units()
        fixed = next(u for u in data["units"] if "a28 fixed" in u["patch"])
        self.assertIn(fixed["id"], grouping[1]["units"])
        self.assertTrue(grouping[0]["body"].startswith("Technical."))
        code, text = self.run_cmd("build", "--base", self.base)
        self.assertEqual(code, 0, text)
        titles = self.git("log", "--reverse", "--format=%s", f"{self.base}..HEAD").split("\n")
        self.assertEqual(titles, ["[c1] a: top change", "[c2] a: bottom change",
                                  "[c3] b: last change"])
        self.assertEqual(self.git("rev-parse", "HEAD^{tree}"), tree)

    def test_fold_assigns_a_new_hunk_by_its_tag(self):
        data, _ = self.list_units()
        self.write_grouping(self.group(data))
        self.run_cmd("build", "--base", self.base)
        self.edit("a.py", 15, "a15 fixed")
        self.commit("[c1] fix: new line", "a.py")
        code, text = self.run_cmd("fold", "--base", self.base)
        self.assertEqual(code, 0, text)
        self.assertNotIn("unassigned", text)


class BaseAndOriginsTest(Grouped):
    def test_build_and_fold_refuse_a_different_base(self):
        data, _ = self.list_units()
        self.write_grouping(self.group(data))
        for cmd in ("build", "fold"):
            code, text = self.run_cmd(cmd, "--base", "HEAD~1")
            self.assertEqual(code, 1, text)
            self.assertIn("recorded base", text)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.tip)

    def test_fix_next_to_another_commit_stays_unassigned(self):
        data, _ = self.list_units()
        self.write_grouping(self.group(data))
        self.run_cmd("build", "--base", self.base)
        self.edit("a.py", 3, "a3 fixed")
        self.commit("[c2] fix: touch the next line", "a.py")
        code, text = self.run_cmd("fold", "--base", self.base)
        self.assertEqual(code, 0, text)
        data, _ = self.list_units()
        unit = next(u for u in data["units"] if "a3 fixed" in u["patch"])
        self.assertEqual(len(unit["origins"]), 2)
        self.assertEqual(len(unit["origin"]), 1)
        self.assertEqual(unit["origins"][0]["title"], unit["origin"][0]["title"])
        self.assertEqual({o["lines"] for o in unit["origins"]}, {1})
        code, text = self.run_cmd("fold", "--base", self.base)
        self.assertIn("unassigned", text)
        self.assertIn(unit["id"], text.split("unassigned")[1])
        with open(self.state("grouping.json")) as fh:
            grouping = json.load(fh)["commits"]
        self.assertFalse(any(unit["id"] in c["units"] for c in grouping))


class AidsTest(Fixture):
    def setUp(self):
        super().setUp()
        self.edit("a.py", 15, "y = compute_beta(7)")
        self.edit("b.py", 15, "z = compute_beta(9)")
        with open(os.path.join(self.dir, "c.py"), "a") as fh:
            fh.write("def helper_fn():\n    return 2\n")
        self.write("d.py", "d = helper_fn()\n")
        self.commit("[s4] more", "a.py", "b.py", "c.py", "d.py")

    def test_classes_groups_hunks_that_differ_only_in_names(self):
        data, _ = self.list_units()
        ids = {u["id"] for u in data["units"] if "compute_beta" in u["patch"]}
        self.assertEqual(len(ids), 2)
        classes = sc.shape_classes(data["units"])
        self.assertTrue(any(ids <= {u["id"] for u in c} for c in classes))
        code, text = self.run_cmd("classes", "--base", self.base)
        self.assertEqual(code, 0, text)
        self.assertIn("hunks in", text)

    def test_symbols_links_definition_to_use(self):
        data, _ = self.list_units()
        by = {u["file"]: u["id"] for u in data["units"] if u["file"] in ("c.py", "d.py")}
        edges = sc.symbol_edges(data["units"])
        self.assertEqual(edges[(by["c.py"], by["d.py"])], {"helper_fn"})
        code, text = self.run_cmd("symbols", "--base", self.base)
        self.assertEqual(code, 0, text)
        self.assertIn(f"helper_fn -> {by['d.py']} d.py", text)
        self.assertIn("hint", text)

    def test_symbols_prints_a_definition_with_no_uses(self):
        self.list_units()
        code, text = self.run_cmd("symbols", "--base", self.base)
        self.assertEqual(code, 0, text)
        self.assertIn("defines c", text)
        self.assertIn("no uses found", text)


if __name__ == "__main__":
    unittest.main()
