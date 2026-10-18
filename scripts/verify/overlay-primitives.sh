#!/usr/bin/env bash
# Check the plugin import boundary and that each shared helper has one definition.
# Prints one ok or FAIL line per check and exits non-zero when any line fails.
set -u
cd "$(dirname "$0")/../.."

fail=0

report() {
	if [ "$2" = "ok" ]; then
		echo "ok    $1"
	else
		echo "FAIL  $1: $3"
		fail=1
	fi
}

violations=$(node --input-type=module - <<'JS'
import fs from "node:fs";
import path from "node:path";

const root = path.resolve("plugins");
const files = [];
const walk = (dir) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full);
		else if (entry.name.endsWith(".ts")) files.push(full);
	}
};
walk(root);

const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']*|\.{1,2})["']/g;
const owner = (file) => path.relative(root, file).split(path.sep)[0];

for (const file of files.sort()) {
	const own = owner(file);
	const text = fs.readFileSync(file, "utf8");
	for (const match of text.matchAll(pattern)) {
		const target = path.resolve(path.dirname(file), match[1]);
		const rel = path.relative(root, target);
		const outside = rel.startsWith("..");
		const targetPlugin = rel.split(path.sep)[0];
		const toShared = !outside && targetPlugin === "shared";
		const toApi = !outside && rel.split(path.sep).length === 2 && /^api(\.ts)?$/.test(rel.split(path.sep)[1]);
		const sameFolder = !outside && targetPlugin === own;
		const allowed = own === "shared" ? sameFolder : sameFolder || toShared || toApi;
		if (!allowed) {
			console.log(`${path.relative(process.cwd(), file)} imports ${match[1]}`);
		}
	}
}
JS
)

if [ -z "$violations" ]; then
	report "import boundary: 0 imports leave a plugin except to shared or an api.ts" ok
else
	n=$(printf '%s\n' "$violations" | wc -l | tr -d ' ')
	report "import boundary" FAIL "$n offending imports"
	printf '%s\n' "$violations" | sed 's/^/        /'
fi

scan=()
for f in plugins/*/extensions plugins/*/api.ts plugins/shared/*.ts; do
	[ -e "$f" ] && scan+=("$f")
done

count_files() {
	grep -rlF --include='*.ts' --exclude-dir=tests --exclude-dir=node_modules -e "$1" "${scan[@]}" 2>/dev/null | wc -l | tr -d ' '
}

dup() {
	local label=$1 needle=$2 n
	n=$(count_files "$needle")
	if [ "$n" = "1" ]; then
		report "$label defined in 1 file" ok
	else
		report "$label" FAIL "defined in $n files, expected 1"
	fi
}

dup "function clamp" "function clamp"
dup "function viewportTop" "function viewportTop"
dup "COPIED_MS" "COPIED_MS ="
dup "WHEEL_LINES" "WHEEL_LINES ="
dup "function copyToClipboard" "function copyToClipboard"

box=$( { grep -rlF --include='*.ts' --exclude-dir=tests --exclude-dir=node_modules -e '╭' "${scan[@]}"; grep -rlF --include='*.ts' --exclude-dir=tests --exclude-dir=node_modules -e '┌' "${scan[@]}"; } 2>/dev/null | sort -u | wc -l | tr -d ' ')
if [ "$box" = "1" ]; then
	report "box frame defined in 1 file" ok
else
	report "box frame" FAIL "defined in $box files, expected 1"
fi

exit "$fail"
