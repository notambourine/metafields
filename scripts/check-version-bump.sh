#!/usr/bin/env bash
# Published changes need a version bump because merging that bump triggers release.
# Paths default to published unless explicitly exempted below.
set -uo pipefail

BASE=${1:-origin/main}

MERGE_BASE=$(git merge-base "$BASE" HEAD) || {
	printf 'check-version-bump: cannot resolve a merge base with %s\n' "$BASE" >&2
	exit 1
}

# Paths that never reach the published tarball or the code that builds it.
is_exempt() {
	case "$1" in
		.github/* | test/* | test-d/* | scripts/* | .gitignore | PLAN.md) return 0 ;;
		# Lockfile churn is devDependencies only; a runtime dep would show in package.json,
		# which is checked on its own contents below.
		package-lock.json) return 0 ;;
		*) return 1 ;;
	esac
}

# package.json is shipped, but a version bump and a devDependencies bump are not reasons
# to demand another bump. Compare everything else.
package_json_ships_a_change() {
	local a b
	a=$(git show "$MERGE_BASE:package.json" | jq -S 'del(.version, .devDependencies)')
	b=$(jq -S 'del(.version, .devDependencies)' package.json)
	[[ "$a" != "$b" ]]
}

SHIPPED=()
while IFS= read -r f; do
	[[ -z "$f" ]] && continue
	is_exempt "$f" && continue
	if [[ "$f" == package.json ]]; then
		package_json_ships_a_change && SHIPPED+=("$f")
		continue
	fi
	SHIPPED+=("$f")
done < <(git diff --name-only "$MERGE_BASE" HEAD)

if (( ${#SHIPPED[@]} == 0 )); then
	echo "No published files changed; no version bump needed."
	exit 0
fi

OLD=$(git show "$MERGE_BASE:package.json" | jq -r .version)
NEW=$(jq -r .version package.json)

printf 'Published files changed (%d):\n' "${#SHIPPED[@]}"
printf '  %s\n' "${SHIPPED[@]}"

if [[ "$OLD" == "$NEW" ]]; then
	cat >&2 <<EOF

FAIL: version is still $NEW. Those files ship, so this change needs a release.
Run 'npm version patch --no-git-tag-version' and commit package.json.
EOF
	exit 1
fi

# A typo that lowers the version would publish nothing and silently skip the release.
if [[ "$(printf '%s\n%s\n' "$OLD" "$NEW" | sort -V | tail -1)" != "$NEW" ]]; then
	printf '\nFAIL: version went backwards, %s -> %s.\n' "$OLD" "$NEW" >&2
	exit 1
fi

printf '\nVersion bumped %s -> %s.\n' "$OLD" "$NEW"
