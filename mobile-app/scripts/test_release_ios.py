"""Isolated release regression tests; never invoke Apple tools or real credentials.

Run: python3 -m unittest discover -s mobile-app/scripts -p 'test_release_ios.py' -v
"""
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
WRAPPER = Path.home() / "ship-native.sh"
BUILD = "42"
BUNDLE = "com.example.release-test"

# Every external build/upload operation is replaced, while real shell control
# flow, node stamping, plist parsing and ZIP reading run in a disposable tree.
MOCK = r'''#!__PYTHON__
import json, os, pathlib, plistlib, sys, zipfile
p = pathlib.Path
args = sys.argv[1:]
name = p(sys.argv[0]).name
case = os.environ.get('CASE', 'success')
root = p(os.environ['FIXTURE_APP'])
with open(os.environ['CALLS'], 'a') as log:
    log.write(json.dumps([name, args]) + '\n')
def stamp(stage):
    return {'CFBundleVersion': '41' if case == stage + '_build' else '42',
            'CFBundleIdentifier': 'com.wrong.app' if case == stage + '_bundle' else 'com.example.release-test'}
def plist(path, stage):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(plistlib.dumps(stamp(stage)))
def ipa(path, stage='ipa'):
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('Payload/Agents.app/Info.plist', plistlib.dumps(stamp(stage)))
if name == 'npx':
    plist(root / 'ios/Agents/Info.plist', 'generated')
    (root / 'ios/Pods').mkdir(exist_ok=True)
    (root / 'ios/Podfile.lock').write_text('RNReanimated\n')
    (root / 'ios/Agents/Agents.entitlements').write_text('<key>aps-environment</key>\n<string>production</string>\n')
    sys.exit(23 if case == 'prebuild_fail' else 0)
if name == 'xcodebuild':
    if 'archive' in args:
        if case == 'archive_fail': sys.exit(24)
        target = p(args[args.index('-archivePath')+1]) / 'Products/Applications/Agents.app/Info.plist'
        plist(target, 'archive')
        if case == 'archive_missing': target.unlink()
        if case == 'archive_malformed': target.write_text('not a plist')
        if case == 'archive_unreadable': target.chmod(0)
        if case == 'archive_unresolved':
            target.write_bytes(plistlib.dumps(dict(stamp('archive'), CFBundleIdentifier='$(PRODUCT_BUNDLE_IDENTIFIER)')))
    else:
        out = p(args[args.index('-exportPath')+1]); out.mkdir(parents=True, exist_ok=True)
        if case == 'export_fail': sys.exit(25)
        if case not in ('ipa_missing', 'stale_only'):
            target = out / 'Checked App.ipa'; ipa(target)
            if case == 'ipa_multiple': ipa(out / 'Other.ipa')
            if case == 'ipa_nested_multiple':
                (out / 'nested').mkdir(); ipa(out / 'nested/Other.ipa')
            if case == 'ipa_malformed': target.write_text('not a zip')
            if case == 'ipa_bad_plist':
                with zipfile.ZipFile(target, 'w') as z: z.writestr('Payload/Agents.app/Info.plist', 'not a plist')
            if case == 'ipa_no_app':
                with zipfile.ZipFile(target, 'w') as z: z.writestr('unrelated.txt', 'nothing')
            if case == 'ipa_two_apps':
                with zipfile.ZipFile(target, 'a') as z: z.writestr('Payload/Other.app/Info.plist', plistlib.dumps(stamp('ipa')))
            if case == 'ipa_duplicate_plist':
                with zipfile.ZipFile(target, 'a') as z: z.writestr('Payload/Agents.app/Info.plist', plistlib.dumps(stamp('ipa')))
            if case == 'ipa_symlink':
                target.unlink(); target.symlink_to(root / 'build/ipa/Old.ipa')
            if case == 'ipa_unreadable': target.chmod(0)
    sys.exit(0)
if name == 'xcrun':
    if '--validate-app' in args and case == 'validate_fail': sys.exit(26)
    if '--upload-app' in args and case == 'upload_fail': sys.exit(27)
    sys.exit(0)
if name == 'python3' and args and args[0].endswith('/asc.py'):
    if args[1] == 'newest':
        print('2026-09-19T00:00:00Z'); sys.exit(29 if case == 'floor_fail' else 0)
    sys.exit(28 if case == 'watch_fail' else 0)
if name == 'python3': os.execv('__PYTHON__', ['__PYTHON__'] + args)
if name == 'security': raise SystemExit('Signing must never run in tests')
raise SystemExit('Unexpected mock command: ' + name)
'''


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='release-regression-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / 'app'
        (self.app / 'scripts').mkdir(parents=True)
        for name in ('release-ios.sh', 'release_identity.py'):
            source = SCRIPTS / name
            if source.exists(): shutil.copy2(source, self.app / 'scripts' / name)
        (self.app / 'app.json').write_text(json.dumps({'expo': {'ios': {'buildNumber': BUILD, 'bundleIdentifier': BUNDLE}}}))
        self.plist(self.app / 'ios/Agents/Info.plist')
        # A valid stale IPA must NEVER satisfy a fresh export's artifact gate.
        import zipfile
        old = self.app / 'build/ipa/Old.ipa'
        old.parent.mkdir(parents=True)
        with zipfile.ZipFile(old, 'w') as z:
            z.writestr('Payload/Agents.app/Info.plist', plistlib.dumps({'CFBundleVersion': BUILD, 'CFBundleIdentifier': BUNDLE}))
        self.bin = self.root / 'bin'; self.bin.mkdir()
        for name in ('npx', 'xcodebuild', 'xcrun', 'python3', 'security'):
            target = self.bin / name
            target.write_text(MOCK.replace('__PYTHON__', sys.executable)); target.chmod(0o755)
        self.calls = self.root / 'calls.jsonl'
        self.key = self.root / 'fake.p8'; self.key.write_text('TEST ONLY')
        self.env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}', HOME=str(self.root),
                        FIXTURE_APP=str(self.app), CALLS=str(self.calls), BUILD_NUMBER=BUILD,
                        BUNDLE_ID=BUNDLE, TEAM_ID='TEST', ASC_KEY_ID='TEST', ASC_ISSUER_ID='TEST',
                        ASC_KEY_PATH=str(self.key), KEYCHAIN_PASSWORD='')
        self.env.pop('BASH_ENV', None)

    def plist(self, path, **overrides):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(plistlib.dumps(dict({'CFBundleVersion': BUILD, 'CFBundleIdentifier': BUNDLE}, **overrides)))

    def run_release(self, case='success', wrapper=False):
        script = self.app / 'scripts/release-ios.sh'
        if wrapper:
            # Sanitize ONLY host setup/credentials/cwd in the copied wrapper.
            # Stage commands and control flow stay exactly as in the real file.
            text = WRAPPER.read_text()
            text = '\n'.join(line for line in text.splitlines()
                             if not re.match(r'export (PATH=|NVM_DIR=|TEAM_ID=|ASC_|KEYCHAIN_PASSWORD=)', line)) + '\n'
            text, count = re.subn(r'^cd ".*?/mobile-app" \|\| exit 1$', f'cd "{self.app}" || exit 1', text, flags=re.M)
            self.assertEqual(count, 1, 'Wrapper checkout setup changed; review fixture sanitization')
            script = self.root / 'ship-native.sh'; script.write_text(text)
        result = subprocess.run(['/bin/bash', str(script)], env=dict(self.env, CASE=case),
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=30)
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []
        return result, calls

    def stage(self, calls, token):
        return [args for name, args in calls if token in args]

    def test_success_checks_and_uploads_exact_fresh_path_once(self):
        result, calls = self.run_release()
        self.assertEqual(result.returncode, 0, result.stdout)
        validates = self.stage(calls, '--validate-app'); uploads = self.stage(calls, '--upload-app')
        self.assertEqual(len(validates), 1); self.assertEqual(len(uploads), 1)
        checked = validates[0][validates[0].index('-f')+1]
        self.assertEqual(checked, uploads[0][uploads[0].index('-f')+1])
        export = self.stage(calls, '-exportArchive')[0]
        destination = Path(export[export.index('-exportPath')+1])
        self.assertNotEqual(destination, self.app / 'build/ipa')
        self.assertEqual(Path(checked).parent, destination)
        self.assertIn(f'ipa identity verified: {BUNDLE} / {BUILD} ({checked})', result.stdout)

    def test_each_invocation_gets_its_own_export(self):
        paths = []
        for _ in range(2):
            self.calls.unlink(missing_ok=True)
            result, calls = self.run_release()
            self.assertEqual(result.returncode, 0, result.stdout)
            uploads = self.stage(calls, '--upload-app')
            self.assertEqual(len(uploads), 1)
            paths.append(uploads[0][uploads[0].index('-f')+1])
        self.assertNotEqual(paths[0], paths[1])

    def test_generated_identity_failure_stops_before_archive(self):
        for kind in ('build', 'bundle', 'missing', 'malformed', 'unreadable', 'unknown_substitution', 'non_dict'):
            with self.subTest(kind=kind):
                path = self.app / 'ios/Agents/Info.plist'
                self.plist(path)
                if kind == 'build': self.plist(path, CFBundleVersion='41')
                if kind == 'bundle': self.plist(path, CFBundleIdentifier='com.wrong.app')
                if kind == 'missing': path.unlink()
                if kind == 'malformed': path.write_text('not a plist')
                if kind == 'unreadable': path.chmod(0)
                if kind == 'unknown_substitution': self.plist(path, CFBundleIdentifier='$(OTHER_BUNDLE)')
                if kind == 'non_dict': path.write_bytes(plistlib.dumps(['not a dictionary']))
                self.calls.unlink(missing_ok=True)
                try:
                    result, calls = self.run_release()
                finally:
                    if path.exists(): path.chmod(0o600)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(self.stage(calls, 'archive'), [])
                self.assertEqual(self.stage(calls, '--upload-app'), [])

    def test_generated_documented_bundle_substitutions(self):
        for bundle in ('$(PRODUCT_BUNDLE_IDENTIFIER)', '${PRODUCT_BUNDLE_IDENTIFIER}'):
            with self.subTest(bundle=bundle):
                self.plist(self.app / 'ios/Agents/Info.plist', CFBundleIdentifier=bundle)
                self.calls.unlink(missing_ok=True)
                result, _ = self.run_release()
                self.assertEqual(result.returncode, 0, result.stdout)

    def test_archive_failure_stops_before_export(self):
        for case in ('archive_build', 'archive_bundle', 'archive_missing', 'archive_malformed', 'archive_unreadable', 'archive_unresolved', 'archive_fail'):
            with self.subTest(case=case):
                self.calls.unlink(missing_ok=True)
                result, calls = self.run_release(case)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(self.stage(calls, '-exportArchive'), [])
                self.assertEqual(self.stage(calls, '--upload-app'), [])

    def test_export_failures_never_validate_or_upload(self):
        for case in ('ipa_build', 'ipa_bundle', 'ipa_missing', 'ipa_multiple', 'ipa_nested_multiple',
                     'ipa_malformed', 'ipa_bad_plist', 'ipa_no_app', 'ipa_two_apps', 'ipa_duplicate_plist',
                     'ipa_symlink', 'ipa_unreadable', 'stale_only', 'export_fail'):
            with self.subTest(case=case):
                self.calls.unlink(missing_ok=True)
                result, calls = self.run_release(case)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(self.stage(calls, '--validate-app'), [])
                self.assertEqual(self.stage(calls, '--upload-app'), [])

    def test_validation_failure_never_uploads(self):
        result, calls = self.run_release('validate_fail')
        self.assertEqual(result.returncode, 26, result.stdout)
        self.assertEqual(self.stage(calls, '--upload-app'), [])

    def test_wrapper_propagates_stage_failures(self):
        for case, code in (('prebuild_fail', 23), ('archive_fail', 24), ('validate_fail', 26),
                           ('upload_fail', 27), ('watch_fail', 28), ('floor_fail', 29)):
            with self.subTest(case=case):
                self.calls.unlink(missing_ok=True)
                result, calls = self.run_release(case, wrapper=True)
                self.assertEqual(result.returncode, code, result.stdout)
                self.assertIn(f'SHIP_DONE rc={code}', result.stdout)
                if case not in ('upload_fail', 'watch_fail'):
                    self.assertEqual(self.stage(calls, '--upload-app'), [])
                if case != 'watch_fail': self.assertEqual(self.stage(calls, 'watch'), [])
                if case == 'prebuild_fail': self.assertEqual(self.stage(calls, 'archive'), [])

    def test_wrapper_success(self):
        result, calls = self.run_release(wrapper=True)
        self.assertEqual(result.returncode, 0, result.stdout)
        for marker in ('PREBUILD exit=0', 'RELEASE exit=0', 'WATCH exit=0', 'SHIP_DONE rc=0'):
            self.assertIn(marker, result.stdout)
        self.assertEqual(len(self.stage(calls, '--validate-app')), 1)
        self.assertEqual(len(self.stage(calls, '--upload-app')), 1)
        self.assertEqual(len(self.stage(calls, 'watch')), 1)

    def test_direct_prebuild_failure_stops_archive(self):
        shutil.rmtree(self.app / 'ios')
        result, calls = self.run_release('prebuild_fail')
        self.assertEqual(result.returncode, 23, result.stdout)
        self.assertEqual(self.stage(calls, 'archive'), [])


if __name__ == '__main__':
    unittest.main()
