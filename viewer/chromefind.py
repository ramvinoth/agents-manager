"""Where Chrome/Chromium lives, on any host.

Self-contained (stdlib only, Python 3.8+) on purpose: browser.py ships this
file's source to SSH hosts ahead of its probe script, so this one list is what
both a local PDF export and a remote browser probe search.
"""
import glob
import os
import shutil


def find_chrome():
    """A Chrome/Chromium binary on this machine, or None."""
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        if shutil.which(name):
            return shutil.which(name)
    for p in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              "/Applications/Chromium.app/Contents/MacOS/Chromium", "/snap/bin/chromium"):
        if os.path.exists(p):
            return p
    for var in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):  # Windows installs
        base = os.environ.get(var)
        p = base and os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")
        if p and os.path.exists(p):
            return p
    for root in ("~/.cache/ms-playwright", "~/Library/Caches/ms-playwright"):
        root = os.path.expanduser(root)
        hits = sorted(glob.glob(root + "/chromium-*/chrome-linux/chrome")
                      + glob.glob(root + "/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium"))
        if hits:
            return hits[-1]
    return None
