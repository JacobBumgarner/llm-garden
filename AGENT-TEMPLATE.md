## Python
Always run Python through `uv`. The project env is uv-managed, so never use bare
`python`/`python3`, as these skip project deps.
- Correct format: `uv run python ...`, `uv run pytest ...`
- Never use bare `python` or `python3` ❌

## Code comments

The default is **no comment**. Code carries the *what*; the docstring carries
the contract. An inline comment must add something neither can.

Write one only when the line has a quirk the reader cannot infer:
- why an obvious alternative was rejected
- why a specific cast / flag / call is there
- a load-bearing ordering constraint
- a non-obvious source for a magic value

Keep comments concise. A fragment or one sentence. If the comment runs more than
a line, the explanation belongs in the docstring or a linked design doc, not
above the code.

If a comment narrates the line below it ("Increment counter"; "If X, do Y;
otherwise Z") or echoes the docstring's invariants, arguments, or steps, delete
it. Same for section headers inside short functions ("# Setup", "# Loop", "#
Return").

**Comments and docstrings stand alone.** Never reference plans, phases,
stages, migrations, "the new X" / "the old Y", or any other framing that only
makes sense with external context in hand. The reader has the code, nothing
else. If context matters, inline the relevant fact; don't point at `plan/` or
at a past state of the codebase.

## Call sites
Pass arguments by keyword when a call takes more than one argument, or when the
value's role isn't obvious. Single-argument calls, self-naming calls, and
builtin/stdlib methods with well-known signatures stay positional: `len(items)`,
`Path(config_path)`, `cfg.get("host", "localhost")`.

## Linting & docstrings
Ruff (installed globally via `uv`) enforces imports, modern syntax, docstrings
(`D`), and signature type annotations (`ANN`) -- see the full rule set in
`pyproject.toml`. Run `uvx ruff check . --fix` and `uvx ruff format .`. Use
`--fix` for auto-fixable lints; surface the rest for human review rather than
suppressing.

Beyond linting:
- Write concise docstrings. Trivial helpers get one line. Write more only when
  the function or class behavior genuinely need more context to understand their
  behavior beyond the code.
- Lead with what the function does, in the imperative. Don't restate the
  signature, the name, or the types. If a section (Args, Returns, Raises) only
  echoes what the signature already says, drop it.
- Describe behavior and code contract, not placement. Don't claim where a
  function lives or who calls it. Location claims go stale silently when code
  moves. If the caller has to provide something for the function to work, state
  it as a requirement on the caller, not as a fact about location.
- **Docstrings and comments are self-contained.** Describe the code as it is,
  not the process that produced it. No references to plans, phases, stages,
  milestones, migrations, refactors, rollouts, "the new X", "the old Y", "step
  2 of…", "as discussed", "for MVP", "eventually", or anything else that only
  makes sense to a reader holding external context. A future reader has the
  code and nothing else -- write for them. If the historical framing genuinely
  matters, it belongs in a commit message or a design doc, not in the source.
  Same rule for `plan/` paths: never reference them from code.
- Drop hedges and adjectives. State the mechanism, not how reliable or elegant
  it is.
- Ruff only enforces the public surface, so docstring private helpers too.
- Keep the module header current when you change a file's contents.
- Follow PEP 8 naming - `CamelCase` classes, `snake_case` functions/variables -
  matching an external API's casing only when wrapping it directly.

Pre-commit hooks can be run via `uvx prek run -a` or `uvx prek run -f <file>`.

## Testing
Talk with the human about tests ahead of implementation to align on development
contracts. Tests are paramount for stability, but they must be meaningful and
targeted. All code should have clearly discussed success criteria.

- Test runner: `pytest` + `pytest-asyncio`.
- Run tests with: `uv run pytest` (not `uvx pytest`, pytest needs to import the
  project).
- Run a single test file: `uv run pytest tests/unit/test_foo.py`
- Run the dev server: `uv run delphi-api` (or `uv run delphi-local` to bring up
  Postgres + DB + API in one shot).
- Unit tests `tests/unit` should contain pure logical tests, and integration
  tests `tests/integration` should be used for anything that touches real
  endpoints or real data.

## Contributing
Feature branches off `main` using prefixes: `feat/`, `fix/`, `refactor/`,
`maint/`, `doc/`, `test/`, `junk/`. PRs require review from at least one team
member before merging.

**After finishing work, run `uvx prek run -a`.** Don't rely on git's pre-commit
hook firing, as it only runs if the developer has separately run `uv run prek
install`, and agent sessions usually have not. A commit that hasn't been through
`prek run -a` is not done. Run `uv run pytest` before opening a PR.

Agents must not commit independently on behalf of users.

