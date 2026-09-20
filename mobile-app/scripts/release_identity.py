"""Fail-closed identity gates used by release-ios.sh (stdlib only)."""
import os
from pathlib import Path
import plistlib
import re
import sys
import zipfile


def check_identity(info, stage, bundle, build):
    if not isinstance(info, dict):
        raise ValueError(f"{stage}: Info.plist is not a dictionary")
    allowed_bundles = {bundle}
    if stage == "generated":
        # Xcode resolves these exact substitutions from the command-line
        # PRODUCT_BUNDLE_IDENTIFIER. No other unresolved identifier is accepted.
        allowed_bundles.update({"$(PRODUCT_BUNDLE_IDENTIFIER)", "${PRODUCT_BUNDLE_IDENTIFIER}"})
    actual_bundle = info.get("CFBundleIdentifier")
    actual_build = info.get("CFBundleVersion")
    if actual_bundle not in allowed_bundles or actual_build != build:
        raise ValueError(f"{stage}: identity {actual_bundle!r}/{actual_build!r} "
                         f"does not match {bundle!r}/{build!r}")


def checked_ipa(directory):
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("export destination is missing or is not a real directory")
    candidates = []
    def walk_error(error):
        raise error
    for root, dirs, files in os.walk(directory, onerror=walk_error):
        if any((Path(root) / name).is_symlink() for name in dirs):
            raise ValueError("export contains a symlinked directory")
        candidates.extend(Path(root) / name for name in files if name.lower().endswith(".ipa"))
    if len(candidates) != 1:
        raise ValueError(f"expected exactly one exported IPA, found {len(candidates)}")
    path = candidates[0]
    if path.is_symlink() or not path.is_file() or "\n" in str(path) or "\r" in str(path):
        raise ValueError("exported IPA must be a regular file with an unambiguous path")
    with zipfile.ZipFile(path) as archive:
        bad_member = archive.testzip()
        if bad_member is not None:
            raise ValueError(f"corrupt IPA member: {bad_member}")
        # Only the main app, not extensions/frameworks; duplicate ZIP entries
        # count too, so an ambiguous Payload cannot pass by taking the first.
        plists = [entry for entry in archive.infolist()
                  if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", entry.filename)]
        if len(plists) != 1:
            raise ValueError(f"expected exactly one main-app Info.plist, found {len(plists)}")
        info = plistlib.loads(archive.read(plists[0]))
    return path, info


def main():
    stage, source, bundle, build = sys.argv[1:]
    if not bundle or not build:
        raise ValueError("intended bundle and build must be nonempty")
    if stage == "ipa":
        path, info = checked_ipa(Path(source))
    elif stage in ("generated", "archive"):
        path = Path(source)
        with path.open("rb") as stream:
            info = plistlib.load(stream)
    else:
        raise ValueError(f"unknown artifact stage: {stage}")
    check_identity(info, stage, bundle, build)
    print(f"{stage} identity verified: {bundle} / {build} ({path})", file=sys.stderr)
    if stage == "ipa":
        # The caller captures this once, then validates/uploads precisely it.
        print(path)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: release artifact gate: {error}", file=sys.stderr)
        sys.exit(1)
