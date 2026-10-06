"""A function-local `from viewer import db` (or any re-import of a module the
file already imports at the top) makes the name LOCAL to the whole function, so
every use above that line raises UnboundLocalError. Wrapped in a best-effort
try/except it fails silently: start_claude_run lost its in-flight record this
way and server restarts stopped resuming cut-off turns (2026-10-06)."""
import importlib
import pkgutil
import types

import viewer


def _codes(obj):
    if isinstance(obj, types.FunctionType):
        yield obj.__code__
    elif isinstance(obj, type):
        for v in vars(obj).values():
            yield from _codes(getattr(v, "__func__", v))


def _nested(code):
    yield code
    for c in code.co_consts:
        if isinstance(c, types.CodeType):
            yield from _nested(c)


def test_no_function_rebinds_a_module_level_module_import():
    bad = []
    for info in pkgutil.walk_packages(viewer.__path__, "viewer."):
        mod = importlib.import_module(info.name)
        modules = {k for k, v in vars(mod).items() if isinstance(v, types.ModuleType)}
        for obj in vars(mod).values():
            if getattr(obj, "__module__", None) != mod.__name__:
                continue
            for top in _codes(obj):
                for code in _nested(top):
                    for name in (set(code.co_varnames) | set(code.co_cellvars)) & modules:
                        bad.append(f"{info.name}:{code.co_name} rebinds {name}")
    assert not bad, bad
