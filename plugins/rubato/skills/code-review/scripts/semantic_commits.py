#!/usr/bin/env python3
"""Rewrite a branch of stage commits into a series of semantic commits.

The agent decides the grouping. This script lists the units of the net diff,
builds the commits from a grouping file with git plumbing, checks the
invariants, and moves the branch. Stdlib only.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"]
FILE_LEVEL_PREFIXES = (
    "rename ", "similarity ", "dissimilarity ", "copy ", "old mode", "new mode",
    "Binary files", "GIT binary patch",
)
SPECIAL_MODES = ("120000", "160000")
TAG_RE = re.compile(r"^\[c(\d+)\]( fix:)?\s*(.*)$")
FIX_RE = re.compile(r"^\[c\d+\] fix:")


class Fail(Exception):
    """Raise to stop with one line saying why."""


class Repo:
    """Run git in one repository."""

    def __init__(self, path: str):
        self.path = path

    def run(self, *args: str, input: bytes | None = None, env: dict | None = None,
            check: bool = True) -> subprocess.CompletedProcess:
        full_env = dict(os.environ)
        if env:
            full_env.update(env)
        proc = subprocess.run(
            ["git", "-c", "core.quotepath=false", "-C", self.path, *args],
            input=input, capture_output=True, env=full_env,
        )
        if check and proc.returncode != 0:
            msg = proc.stderr.decode("utf-8", "replace").strip()
            raise Fail(f"git {' '.join(args[:2])} failed: {msg}")
        return proc

    def out(self, *args: str, **kw) -> str:
        return self.run(*args, **kw).stdout.decode("utf-8", "surrogateescape")

    def line(self, *args: str, **kw) -> str:
        return self.out(*args, **kw).strip()

    def ok(self, *args: str) -> bool:
        return self.run(*args, check=False).returncode == 0


class Out:
    """Print each line and keep it for the build log."""

    def __init__(self):
        self.lines: list[str] = []

    def __call__(self, text: str = "") -> None:
        print(text)
        self.lines.append(text)


# ---------------------------------------------------------------- diff parsing

def git_line_path(line: str) -> str:
    """Return the new path from a `diff --git a/x b/y` line."""
    rest = line[len("diff --git "):]
    idx = rest.rfind(" b/")
    return rest[idx + 3:] if idx >= 0 else rest


def strip_path(token: str, prefix: str) -> str | None:
    token = token.split("\t")[0]
    if token == "/dev/null":
        return None
    return token[len(prefix):] if token.startswith(prefix) else token


def split_sections(text: str) -> list[list[str]]:
    """Split diff text into one list of lines per `diff --git` section."""
    sections: list[list[str]] = []
    for line in text.split("\n"):
        if line.startswith("diff --git "):
            sections.append([line])
        elif sections:
            sections[-1].append(line)
    if sections and sections[-1][-1] == "":
        sections[-1].pop()
    return sections


def parse_section(sec: list[str]) -> dict:
    """Split one section into its header lines and hunks."""
    header: list[str] = []
    hunks: list[dict] = []
    binary = False
    for line in sec:
        in_header = binary or (not hunks and not line.startswith("@@ "))
        if in_header:
            header.append(line)
            if line.startswith(("GIT binary patch", "Binary files")):
                binary = True
            continue
        if line.startswith("@@ "):
            m = HUNK_RE.match(line)
            if not m:
                raise Fail(f"cannot parse hunk header: {line}")
            hunks.append({
                "old": [int(m[1]), int(m[2] if m[2] is not None else 1)],
                "new": [int(m[3]), int(m[4] if m[4] is not None else 1)],
                "lines": [line],
            })
        else:
            hunks[-1]["lines"].append(line)
    return {"header": header, "hunks": hunks, "binary": binary}


def section_is_file_level(parsed: dict) -> bool:
    header = parsed["header"]
    if not parsed["hunks"] or parsed["binary"]:
        return True
    for line in header:
        if line.startswith(FILE_LEVEL_PREFIXES):
            return True
        if line.startswith(("new file mode", "deleted file mode")) and \
                line.split()[-1] in SPECIAL_MODES:
            return True
        if line.startswith("index ") and line.split()[-1] in SPECIAL_MODES:
            return True
    return False


def section_path(parsed: dict) -> str:
    header = parsed["header"]
    for line in header:
        if line.startswith("rename to "):
            return line[len("rename to "):]
    new = old = None
    for line in header:
        if line.startswith("+++ "):
            new = strip_path(line[4:], "b/")
        elif line.startswith("--- "):
            old = strip_path(line[4:], "a/")
    return new or old or git_line_path(header[0])


def section_paths(parsed: dict) -> set[str]:
    paths = {section_path(parsed), git_line_path(parsed["header"][0])}
    for line in parsed["header"]:
        if line.startswith("rename from "):
            paths.add(line[len("rename from "):])
    return paths


def read_stage_log(repo: Repo, base: str, tip: str):
    """Return the commits in order, who last added each line, who last touched each path."""
    log = repo.out("log", "--reverse", "--no-renames", "-p", "-U0", "--no-color",
                   "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/",
                   "--format=@@COMMIT %H %s", f"{base}..{tip}")
    commits: list[dict] = []
    adder: dict[tuple, int] = {}
    touched: dict[str, int] = {}
    idx = -1
    path = None
    in_header = False
    binary = False
    for line in log.split("\n"):
        if line.startswith("@@COMMIT "):
            h, _, title = line[len("@@COMMIT "):].partition(" ")
            commits.append({"commit": h, "title": title})
            idx += 1
            in_header = False
        elif line.startswith("diff --git "):
            in_header = True
            binary = False
            path = git_line_path(line)
            touched[path] = idx
        elif in_header and line.startswith("+++ "):
            path = strip_path(line[4:], "b/") or path
            touched[path] = idx
        elif in_header and line.startswith("--- "):
            old = strip_path(line[4:], "a/")
            if old:
                touched[old] = idx
        elif line.startswith("@@ "):
            in_header = False
        elif not in_header and not binary and line.startswith("+") and path:
            adder[(path, line[1:])] = idx
        if line.startswith("GIT binary patch"):
            binary = True
    return commits, adder, touched


def vote_origin(path: str, added: list[str], adder: dict, touched: dict) -> list[tuple[int, int]]:
    """Return (commit index, line count) for each commit that added a hunk's lines, winner first.

    The winner added the most lines, and the later commit wins a tie.
    """
    votes = collections.Counter(
        adder[(path, l)] for l in added if l.strip() and (path, l) in adder)
    if votes:
        return sorted(votes.items(), key=lambda kv: (-kv[1], -kv[0]))
    return [(touched[path], 0)] if path in touched else []


def file_unit(uid: str, sec: list[str], parsed: dict, touched: dict) -> dict:
    idxs = [touched[p] for p in section_paths(parsed) if p in touched]
    return {
        "id": uid, "kind": "file", "file": section_path(parsed), "old": None, "new": None,
        "patch": "\n".join(sec) + "\n",
        "origin": [(max(idxs), 0)] if idxs else [],
        "added": 0, "removed": 0,
    }


def hunk_unit(uid: str, path: str, header: str, hunk: dict, adder: dict, touched: dict) -> dict:
    body = [l for l in hunk["lines"][1:] if not l.startswith("\\")]
    added = [l[1:] for l in body if l.startswith("+")]
    return {
        "id": uid, "kind": "hunk", "file": path,
        "old": hunk["old"], "new": hunk["new"],
        "patch": header + "\n".join(hunk["lines"]) + "\n",
        "origin": vote_origin(path, added, adder, touched),
        "added": len(added),
        "removed": sum(1 for l in body if l.startswith("-")),
    }


def build_units(repo: Repo, base: str, tip: str) -> tuple[list[dict], list[dict]]:
    """Return the stage commits and the units of the net diff, each with its origin."""
    diff = repo.out("diff", "-M", "--binary", *DIFF_FLAGS, base, tip)
    commits, adder, touched = read_stage_log(repo, base, tip)
    units: list[dict] = []
    nh = nf = 0
    for sec in split_sections(diff):
        parsed = parse_section(sec)
        if section_is_file_level(parsed):
            nf += 1
            units.append(file_unit(f"f{nf}", sec, parsed, touched))
            continue
        path = section_path(parsed)
        header = "\n".join(parsed["header"]) + "\n"
        for hunk in parsed["hunks"]:
            nh += 1
            units.append(hunk_unit(f"h{nh}", path, header, hunk, adder, touched))
    for u in units:
        votes = u["origin"]
        u["origins"] = [{"hash": commits[i]["commit"], "title": commits[i]["title"], "lines": n}
                        for i, n in votes]
        u["origin"] = [dict(commits[i]) for i, _ in votes[:1]]
    return commits, units


def line_multisets(diff_text: str) -> collections.Counter:
    """Count (path, sign, line) over a zero-context diff."""
    counts: collections.Counter = collections.Counter()
    path = None
    in_header = False
    binary = False
    for line in diff_text.split("\n"):
        if line.startswith("diff --git "):
            in_header = True
            binary = False
            path = git_line_path(line)
        elif in_header and line.startswith("+++ "):
            path = strip_path(line[4:], "b/") or path
        elif in_header and line.startswith("--- "):
            path = strip_path(line[4:], "a/") or path
        elif line.startswith("@@ "):
            in_header = False
        elif line.startswith("GIT binary patch") or line.startswith("Binary files"):
            binary = True
        elif not in_header and not binary and line[:1] in ("+", "-"):
            counts[(path, line[0], line[1:])] += 1
    return counts


# ------------------------------------------------------------------- state paths

def state_dir(repo: Repo, branch: str) -> str:
    git_dir = repo.line("rev-parse", "--absolute-git-dir")
    return os.path.join(git_dir, "code-review", *branch.split("/"))


def current_branch(repo: Repo) -> str:
    proc = repo.run("symbolic-ref", "-q", "HEAD", check=False)
    if proc.returncode != 0:
        raise Fail("HEAD is detached, check out the branch first")
    ref = proc.stdout.decode().strip()
    return ref[len("refs/heads/"):]


def write_json(path: str, data) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")


def read_json(path: str):
    if not os.path.exists(path):
        raise Fail(f"missing {path}")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


# -------------------------------------------------------------------------- list

def write_units(repo: Repo, base_ref: str) -> tuple[str, dict, str]:
    """List the units of the net diff and save them to units.json."""
    branch = current_branch(repo)
    base = repo.line("rev-parse", "--verify", f"{base_ref}^{{commit}}")
    tip = repo.line("rev-parse", "--verify", "HEAD")
    commits, units = build_units(repo, base, tip)
    data = {"branch": branch, "base": base, "tip": tip, "commits": commits, "units": units}
    path = os.path.join(state_dir(repo, branch), "units.json")
    write_json(path, data)
    return branch, data, path


def cmd_list(repo: Repo, args) -> int:
    out = Out()
    branch, data, path = write_units(repo, args.base)
    base, tip, commits, units = data["base"], data["tip"], data["commits"], data["units"]

    out(f"branch {branch}: {len(commits)} commits, {len(units)} units, base {base[:7]}, tip {tip[:7]}")
    out("stage commits:")
    for c in commits:
        out(f"  {c['commit'][:7]} {c['title']}")
    by_file: dict[str, list[dict]] = collections.OrderedDict()
    for u in units:
        by_file.setdefault(u["file"], []).append(u)
    for file, items in by_file.items():
        out("")
        out(file)
        for u in items:
            if u["kind"] == "hunk":
                span = f"-{u['old'][0]},{u['old'][1]} +{u['new'][0]},{u['new'][1]}"
                what = f"{span} +{u['added']} -{u['removed']}"
            else:
                what = "whole file change"
            titles = "; ".join(o["title"] for o in u["origin"]) or "no origin"
            out(f"  {u['id']:<5} {what}  from: {titles}")
    out("")
    out(f"units written to {path}")
    return 0


# ------------------------------------------------------------------------- build

def load_grouping(path: str, units: list[dict]) -> list[dict]:
    data = read_json(path)
    commits = data.get("commits") if isinstance(data, dict) else None
    if not commits:
        raise Fail("grouping.json has no commits")
    known = {u["id"] for u in units}
    seen: collections.Counter = collections.Counter()
    for i, c in enumerate(commits, 1):
        for key in ("title", "body", "units"):
            if not c.get(key):
                raise Fail(f"commit {i} has no {key}")
        seen.update(c["units"])
    unknown = sorted(x for x in seen if x not in known)
    dupes = sorted(x for x, n in seen.items() if n > 1)
    missing = [u["id"] for u in units if u["id"] not in seen]
    problems = []
    if missing:
        problems.append("missing: " + ", ".join(missing))
    if dupes:
        problems.append("duplicated: " + ", ".join(dupes))
    if unknown:
        problems.append("unknown: " + ", ".join(unknown))
    if problems:
        raise Fail("grouping is invalid, " + "; ".join(problems))
    return commits


def check_base(repo: Repo, ref: str, recorded: str) -> None:
    """Refuse when `ref` is not the base recorded in units.json."""
    base = repo.line("rev-parse", "--verify", f"{ref}^{{commit}}")
    if base != recorded:
        raise Fail(f"--base {ref} is {base[:7]}, not the recorded base {recorded[:7]}, "
                   "run list again")


def cmd_build(repo: Repo, args) -> int:
    out = Out()
    branch = current_branch(repo)
    sdir = state_dir(repo, branch)
    try:
        return _build(repo, out, branch, sdir, args)
    except Fail as exc:
        out(f"build refused: {exc}")
        _write_log(sdir, out)
        return 1


def _write_log(sdir: str, out: Out) -> None:
    os.makedirs(sdir, exist_ok=True)
    with open(os.path.join(sdir, "build.log"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(out.lines) + "\n")


def _build(repo: Repo, out: Out, branch: str, sdir: str, args) -> int:
    data = read_json(os.path.join(sdir, "units.json"))
    units = data["units"]
    base, old_tip = data["base"], data["tip"]
    check_base(repo, args.base, base)
    check_preconditions(repo, branch, base, old_tip, args.force)
    grouping = load_grouping(os.path.join(sdir, "grouping.json"), units)

    tmp = tempfile.mkdtemp(prefix="code-review-")
    try:
        built = apply_grouping(repo, grouping, units, base, os.path.join(tmp, "index"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    new_tip = built[-1]["commit"]

    ok = check_tip_tree(repo, built, old_tip, out)
    ok = check_no_invented_lines(repo, built, base, old_tip, out) and ok
    lint = run_lint(repo, args.lint, args.lint_env, built, base) if ok and args.lint else None
    report_lint(built, lint, out)
    if lint and any(lint):
        ok = False
    if not ok:
        raise Fail("an invariant failed, the branch is untouched")

    move_refs(repo, branch, old_tip, new_tip, out)
    print_old_to_new(data["commits"], units, built, out)
    _write_log(sdir, out)
    return 0


def check_preconditions(repo: Repo, branch: str, base: str, tip: str, force: bool) -> None:
    """Refuse, with one line, when the history is unsafe to rewrite."""
    if not repo.ok("merge-base", "--is-ancestor", base, tip):
        raise Fail(f"the base {base[:7]} is not an ancestor of the tip")
    if repo.line("rev-list", "--merges", f"{base}..{tip}"):
        raise Fail(f"history {base[:7]}..{tip[:7]} is not linear, it holds a merge commit")
    in_range = repo.out("rev-list", f"{base}..{tip}").split()
    unpushed = set(repo.out("rev-list", f"{base}..{tip}", "--not", "--remotes").split())
    pushed = [c for c in in_range if c not in unpushed]
    if pushed:
        raise Fail(f"{len(pushed)} commit(s) in the range are on a remote, first {pushed[0][:7]}")
    if repo.line("rev-parse", "--verify", "HEAD") != tip:
        raise Fail("the branch moved since list, run list again")
    guard = repo.run("rev-parse", "--verify", "-q", f"refs/code-review/{branch}", check=False)
    series = guard.stdout.decode().strip()
    if series and series != tip and not force and not only_fixes_after(repo, series, tip):
        raise Fail("the series was edited since the last organize, use --force to rebuild")


def only_fixes_after(repo: Repo, series: str, tip: str) -> bool:
    """Tell whether every commit past the recorded series is a `[cN] fix:` commit."""
    if not repo.ok("merge-base", "--is-ancestor", series, tip):
        return False
    titles = repo.out("log", "--format=%s", f"{series}..{tip}").splitlines()
    return all(FIX_RE.match(t) for t in titles)


def run_lint(repo: Repo, command: str, envs: list[str], built: list[dict],
             base: str) -> list[list[str]]:
    """Run the lint command at the base and at each commit, return each commit's new lines."""
    tmp = tempfile.mkdtemp(prefix="code-review-lint-")
    wt = os.path.join(tmp, "wt")
    links: list[str] = []
    try:
        repo.run("worktree", "add", "--detach", wt, base)
        links = link_envs(repo.line("rev-parse", "--show-toplevel"), wt, envs)
        baseline = set(lint_lines(command, wt))
        results = []
        for b in built:
            Repo(wt).run("checkout", "-q", "--detach", b["commit"])
            results.append([l for l in lint_lines(command, wt) if l not in baseline])
        return results
    finally:
        for link in links:
            os.unlink(link)
        repo.run("worktree", "remove", "--force", wt, check=False)
        repo.run("worktree", "prune", check=False)
        shutil.rmtree(tmp, ignore_errors=True)


def link_envs(top: str, wt: str, extra: list[str]) -> list[str]:
    """Symlink the working tree's tool environments into the lint worktree."""
    links = []
    for name in ("node_modules", ".venv", *extra):
        src = os.path.join(top, name)
        dst = os.path.join(wt, name)
        if os.path.exists(src) and not os.path.lexists(dst):
            os.symlink(src, dst)
            links.append(dst)
    return links


def lint_lines(command: str, cwd: str) -> list[str]:
    """Return the non-empty output lines, stdout and stderr together, of one lint run."""
    proc = subprocess.run(command, shell=True, cwd=cwd, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT)
    text = proc.stdout.decode("utf-8", "replace")
    return [l.rstrip() for l in text.splitlines() if l.strip()]


def report_lint(built: list[dict], lint: list[list[str]] | None, out: Out) -> None:
    """Print the lint check line and one line per built commit."""
    if lint is None:
        out("lint: skipped")
        status = ["lint skipped"] * len(built)
    else:
        out("lint: FAILED" if any(lint) else "lint: ok")
        status = ["lint FAILED" if new else "lint ok" for new in lint]
    for i, (b, st) in enumerate(zip(built, status), 1):
        out(f"[c{i}] {len(b['units'])} units, {st}")
        for line in (lint[i - 1][:5] if lint else []):
            out(f"  new: {line}")


def apply_grouping(repo: Repo, grouping: list[dict], units: list[dict], base: str,
                   index: str) -> list[dict]:
    """Build one commit per group into a temporary index and return them in order."""
    env = {"GIT_INDEX_FILE": index}
    repo.run("read-tree", f"{base}^{{tree}}", env=env)
    by_id = {u["id"]: u for u in units}
    order = {u["id"]: i for i, u in enumerate(units)}
    built: list[dict] = []
    parent = base
    for n, group in enumerate(grouping, 1):
        ids = sorted(group["units"], key=lambda x: order[x])
        for uid in ids:
            apply_unit(repo, by_id[uid], n, env)
        tree = repo.line("write-tree", env=env)
        title = f"[c{n}] {group['title']}"
        message = f"{title}\n\n{group['body'].rstrip()}\n".encode("utf-8", "surrogateescape")
        commit = repo.line("commit-tree", tree, "-p", parent, input=message)
        built.append({"commit": commit, "tree": tree, "units": ids, "title": title,
                      "parent": parent})
        parent = commit
    return built


def apply_unit(repo: Repo, unit: dict, n: int, env: dict) -> None:
    patch = unit["patch"].encode("utf-8", "surrogateescape")
    proc = repo.run("apply", "--cached", "--recount", "-", input=patch, env=env, check=False)
    if proc.returncode != 0:
        msg = proc.stderr.decode("utf-8", "replace").strip()
        raise Fail(f"commit {n}, unit {unit['id']} does not apply: {msg}")


def check_tip_tree(repo: Repo, built: list[dict], old_tip: str, out: Out) -> bool:
    if built[-1]["tree"] == repo.line("rev-parse", f"{old_tip}^{{tree}}"):
        out("tip tree: identical")
        return True
    out("tip tree: DIFFERENT from the original tip")
    return False


def check_no_invented_lines(repo: Repo, built: list[dict], base: str, old_tip: str,
                            out: Out) -> bool:
    """Compare the added and removed lines of the series with those of the net diff."""
    def lines(a: str, b: str) -> collections.Counter:
        return line_multisets(repo.out("diff", "--no-renames", "-U0", *DIFF_FLAGS, a, b))

    expected = lines(base, old_tip)
    actual: collections.Counter = collections.Counter()
    for b in built:
        actual.update(lines(b["parent"], b["commit"]))
    if actual == expected:
        out("no invented lines: ok")
        return True
    out("no invented lines: FAILED")
    for (path, sign, text), n in list((actual - expected).items())[:5]:
        out(f"  extra {sign}{text!r} in {path} (x{n})")
    for (path, sign, text), n in list((expected - actual).items())[:5]:
        out(f"  missing {sign}{text!r} in {path} (x{n})")
    return False


def move_refs(repo: Repo, branch: str, old_tip: str, new_tip: str, out: Out) -> None:
    """Keep the old tip on a backup ref, record the series, then move the branch."""
    stamp = int(time.time())
    while repo.ok("rev-parse", "--verify", "-q", f"refs/backup/code-review/{branch}/{stamp}"):
        stamp += 1
    backup = f"refs/backup/code-review/{branch}/{stamp}"
    repo.run("update-ref", backup, old_tip)
    repo.run("update-ref", f"refs/code-review/{branch}", new_tip)
    repo.run("update-ref", f"refs/heads/{branch}", new_tip, old_tip)
    out(f"backup ref: {backup}")
    out(f"branch {branch} now at {new_tip[:7]}")


def print_old_to_new(commits: list[dict], units: list[dict], built: list[dict],
                     out: Out) -> None:
    """Print each stage commit with the series commits that received its units."""
    owner = {uid: i for i, b in enumerate(built, 1) for uid in b["units"]}
    out("old to new:")
    for c in commits:
        got = sorted({owner[u["id"]] for u in units
                      if any(o["commit"] == c["commit"] for o in u["origin"])})
        tags = ", ".join(f"[c{i}]" for i in got) or "nothing"
        out(f"  {c['commit'][:7]} {c['title']} -> {tags}")


# -------------------------------------------------------------------------- fold

def cmd_fold(repo: Repo, args) -> int:
    out = Out()
    try:
        return _fold(repo, out, args)
    except Fail as exc:
        out(f"fold refused: {exc}")
        return 1


def _fold(repo: Repo, out: Out, args) -> int:
    recorded = os.path.join(state_dir(repo, current_branch(repo)), "units.json")
    if os.path.exists(recorded):
        check_base(repo, args.base, read_json(recorded)["base"])
    branch, data, _ = write_units(repo, args.base)
    base, tip, units = data["base"], data["tip"], data["units"]
    series, fixes = read_series(repo, data["commits"])
    unassigned = assign_by_tag(units, series)
    commits = [series[n] for n in sorted(series) if series[n]["units"]]
    path = os.path.join(state_dir(repo, branch), "grouping.json")
    write_json(path, {"commits": commits})
    out(f"fold: {len(units)} units from {len(data['commits'])} commits, base {base[:7]}, tip {tip[:7]}")
    for n in sorted(series):
        note = f", fixed by {len(fixes[n])} commit(s): re-read its body" if fixes[n] else ""
        out(f"  c{n}: {len(series[n]['units'])} units{note}")
    if unassigned:
        out(f"unassigned, add each to a commit in grouping.json ({len(unassigned)}):")
        for u in unassigned:
            titles = "; ".join(o["title"] for o in u["origins"]) or "no origin"
            out(f"  {u['id']} {u['file']} from: {titles}")
    out(f"grouping written to {path}")
    return 0


def read_series(repo: Repo, commits: list[dict]) -> tuple[dict[int, dict], dict[int, list[str]]]:
    """Return the `[cN]` commits by number, with tag-free titles and bodies, and the fix titles per number."""
    series: dict[int, dict] = {}
    fixes: dict[int, list[str]] = collections.defaultdict(list)
    for c in commits:
        m = TAG_RE.match(c["title"])
        if not m:
            raise Fail(f"{c['commit'][:7]} {c['title']} carries no [cN] tag, organize first")
        n = int(m[1])
        if m[2]:
            fixes[n].append(c["title"])
        elif n in series:
            raise Fail(f"tag [c{n}] appears twice")
        else:
            body = repo.out("log", "-1", "--format=%b", c["commit"]).strip()
            series[n] = {"title": m[3], "body": body, "units": []}
    missing = sorted(n for n in fixes if n not in series)
    if missing:
        raise Fail("fix commits name a missing commit: " + ", ".join(f"[c{n}]" for n in missing))
    return series, fixes


def assign_by_tag(units: list[dict], series: dict[int, dict]) -> list[dict]:
    """Put each unit in the series commit its origin tag names, return the units with no single tag."""
    unassigned = []
    for u in units:
        tags = {int(m[1]) for o in u["origins"] if (m := TAG_RE.match(o["title"]))}
        if len(tags) == 1:
            series[tags.pop()]["units"].append(u["id"])
        else:
            unassigned.append(u)
    return unassigned


# ------------------------------------------------------------------ mechanical aids

STR_RE = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`(?:\\.|[^`\\])*`')
NUM_RE = re.compile(r"\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b0x[0-9a-fA-F]+\b")
IDENT_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")

PY_DEFS = [re.compile(p) for p in (
    r"^\s*(?:async\s+)?def\s+(\w+)",
    r"^\s*class\s+(\w+)",
    r"^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)",
)]
TS_DEFS = [re.compile(p) for p in (
    r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)",
    r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)",
    r"^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+(\w+)",
    r"^\s*(?:export\s+)?interface\s+(\w+)",
    r"^\s*(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=",
    r"^\s*(?:export\s+)?(?:const\s+)?enum\s+(\w+)",
)]
LANG_DEFS = {".py": PY_DEFS, **{e: TS_DEFS for e in (".ts", ".tsx", ".js", ".jsx", ".mjs")}}


def hunk_lines(unit: dict) -> tuple[list[str], list[str]]:
    """Return the removed and added lines of a hunk unit."""
    lines = unit["patch"].split("\n")
    start = next((i for i, l in enumerate(lines) if l.startswith("@@ ")), len(lines))
    body = [l for l in lines[start + 1:] if not l.startswith("\\")]
    return ([l[1:] for l in body if l.startswith("-")],
            [l[1:] for l in body if l.startswith("+")])


def norm_line(text: str) -> str:
    """Replace strings, numbers, and identifiers so shapes compare equal."""
    text = STR_RE.sub('"S"', text)
    text = NUM_RE.sub("N", text)
    text = IDENT_RE.sub("I", text)
    return re.sub(r"\s+", " ", text).strip()


def shape_key(unit: dict) -> str:
    removed, added = hunk_lines(unit)
    rem = sorted("-" + norm_line(l) for l in removed if l.strip())
    add = sorted("+" + norm_line(l) for l in added if l.strip())
    return "\n".join(rem + add)


def shape_classes(units: list[dict]) -> list[list[dict]]:
    """Group hunk units whose diff text is the same once names and literals are normalized."""
    groups: dict[str, list[dict]] = collections.OrderedDict()
    for u in units:
        if u["kind"] == "hunk":
            groups.setdefault(shape_key(u), []).append(u)
    return sorted((g for g in groups.values() if len(g) > 1), key=len, reverse=True)


def load_units(repo: Repo) -> list[dict]:
    return read_json(os.path.join(state_dir(repo, current_branch(repo)), "units.json"))["units"]


def cmd_classes(repo: Repo, args) -> int:
    units = load_units(repo)
    hunks = [u for u in units if u["kind"] == "hunk"]
    classes = shape_classes(units)
    print(f"shape classes: {len(classes)} with more than one hunk, "
          f"{sum(len(c) for c in classes)} of {len(hunks)} hunks. A hint, not a grouping.")
    for c in classes:
        ex = c[0]
        files = len({u["file"] for u in c})
        ids = " ".join(u["id"] for u in c)
        print(f"  {len(c)} hunks in {files} files, exemplar {ex['file']}:{ex['new'][0]}: {ids}")
        for line in shape_key(ex).split("\n")[:3]:
            print(f"      {line[:100]}")
    return 0


def defined_names(unit: dict) -> set[str]:
    pats = LANG_DEFS.get(os.path.splitext(unit["file"])[1], [])
    names = set()
    for line in hunk_lines(unit)[1]:
        for p in pats:
            m = p.match(line)
            if m:
                names.add(m[1])
    return names


def symbol_edges(units: list[dict]) -> dict[tuple[str, str], set[str]]:
    """Map (defining unit, using unit) to the names that link them."""
    hunks = [u for u in units if u["kind"] == "hunk"]
    definers: dict[str, set[str]] = collections.defaultdict(set)
    for u in hunks:
        for name in defined_names(u):
            definers[name].add(u["id"])
    edges: dict[tuple[str, str], set[str]] = {}
    for name, ids in definers.items():
        if len(name) < 2 or len(ids) != 1:
            continue
        definer = next(iter(ids))
        rx = re.compile(r"\b" + re.escape(name) + r"\b")
        for u in hunks:
            if u["id"] == definer or os.path.splitext(u["file"])[1] not in LANG_DEFS:
                continue
            if any(rx.search(l) for l in hunk_lines(u)[1]):
                edges.setdefault((definer, u["id"]), set()).add(name)
    return edges


def cmd_symbols(repo: Repo, args) -> int:
    units = load_units(repo)
    edges = symbol_edges(units)
    by_id = {u["id"]: u for u in units}
    print("symbols: edges come from a regex over names. About half may be noise from "
          "common words and string matches. Use them as a hint only.")
    users: dict[str, list[tuple[str, str]]] = collections.defaultdict(list)
    for (definer, user), names in edges.items():
        for name in sorted(names):
            users[definer].append((name, user))
    found = False
    for u in units:
        names = defined_names(u) if u["kind"] == "hunk" else set()
        if not names:
            continue
        found = True
        print(f"{u['id']} {u['file']}:{u['new'][0]} defines {', '.join(sorted(names))}")
        for name, user in sorted(users[u["id"]]):
            print(f"  {name} -> {user} {by_id[user]['file']}:{by_id[user]['new'][0]}")
        if not users[u["id"]]:
            print("  no uses found")
    if not found:
        print("no definitions found")
    return 0


# --------------------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="semantic_commits.py")
    parser.add_argument("--repo", default=".", help="repository path")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("list", "build", "fold"):
        sub.add_parser(name).add_argument("--base", required=True, help="base ref of the branch")
    build = sub.choices["build"]
    build.add_argument("--lint", help="lint command, in check mode")
    build.add_argument("--lint-env", action="append", default=[],
                       help="extra directory to symlink into the lint worktree")
    build.add_argument("--force", action="store_true",
                       help="rebuild a series edited since the last organize")
    for name in ("classes", "symbols"):
        sub.add_parser(name).add_argument("--base", help="base ref, accepted for symmetry")
    args = parser.parse_args(argv)
    repo = Repo(args.repo)
    try:
        handlers = {"list": cmd_list, "build": cmd_build, "fold": cmd_fold,
                    "classes": cmd_classes, "symbols": cmd_symbols}
        return handlers[args.cmd](repo, args)
    except Fail as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
