import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { BUNDLED_BRIEFS_DIR, describeBriefs, discoverBriefs } from "../extensions/briefs.ts";

const ORCHESTRATION = ["critic", "editor", "fresh-reader", "implementer", "proofing", "recon", "reviewer"].map((n) => `orchestration/${n}`);

test("the bundled orchestration briefs are discovered by group/name with their files", () => {
	const briefs = discoverBriefs(path.join(os.tmpdir(), "no-such-briefs-dir"));
	assert.deepEqual(
		briefs.map((b) => b.name),
		ORCHESTRATION,
	);
	for (const brief of briefs) {
		assert.equal(brief.filePath, path.join(BUNDLED_BRIEFS_DIR, `${brief.name}.md`));
		assert.ok(brief.description.length > 20, `${brief.name} has a description`);
	}
});

test("a user brief is added, a user file of the same name wins, and files without frontmatter are skipped", () => {
	const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "briefs-test-"));
	fs.mkdirSync(path.join(userDir, "orchestration"));
	fs.writeFileSync(path.join(userDir, "orchestration", "critic.md"), "---\nname: orchestration/critic\ndescription: mine\n---\nMine.\n");
	fs.writeFileSync(path.join(userDir, "notes.md"), "---\nname: notes\ndescription: Take notes.\n---\nNotes.\n");
	fs.writeFileSync(path.join(userDir, "plain.md"), "No frontmatter.\n");
	try {
		const briefs = discoverBriefs(userDir);
		assert.deepEqual(
			briefs.map((b) => b.name),
			["notes", ...ORCHESTRATION],
		);
		assert.equal(briefs.find((b) => b.name === "orchestration/critic")?.filePath, path.join(userDir, "orchestration", "critic.md"));
		assert.match(describeBriefs(briefs), /^notes: Take notes\.; orchestration\/critic: mine; /);
	} finally {
		fs.rmSync(userDir, { recursive: true, force: true });
	}
});

test("describeBriefs says none for an empty list", () => {
	assert.equal(describeBriefs([]), "none");
});
