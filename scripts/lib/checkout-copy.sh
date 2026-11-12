# Sourced by test-base.sh and run-with-profile.sh.
#
# copy_checkout <repo> <work>: copies into <work> the files git tracks or
# would track in <repo>, without profile/ (the caller puts its own there).
# A tracked file deleted in the working tree is left out, as a checkout of
# it would be. node_modules is not copied: the caller links it.
copy_checkout() {
	local repo="$1" work="$2"
	git -C "$repo" ls-files -z --cached --others --exclude-standard -- . ':!profile' |
		while IFS= read -r -d '' file; do if [ -e "$repo/$file" ]; then printf '%s\0' "$file"; fi; done |
		rsync -a --from0 --files-from=- "$repo/" "$work/"
}
