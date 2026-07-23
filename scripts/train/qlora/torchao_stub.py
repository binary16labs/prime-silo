"""Inert `torchao` meta-path stub for Windows-ROCm torch.

torchao has no working Windows-ROCm build (its import references a c10d functional op
absent from the ROCm torch wheel), yet transformers' quantizer layer imports it eagerly.
Unsloth stubs it internally; the eager transformers+peft+bitsandbytes path (used by the
T3 eval harness) does the same here so `import transformers` succeeds. torchao is never
actually used — 4-bit is bitsandbytes — so an inert stub is safe.

`import torchao_stub` (before importing transformers) installs it. Lifted from the T0
`run_smoke_vanilla.py` stub, proven on gfx1200.
"""

import importlib.abc
import importlib.machinery
import sys
import types


def _is_dunder(name: str) -> bool:
    return name.startswith("__") and name.endswith("__")


class _StubMeta(type):
    """Metaclass so every torchao symbol is a real class: valid isinstance() arg
    (returns False), dict key, and callable. Attribute chains yield more stub classes;
    dunders raise AttributeError so inspect/import introspection behaves normally."""

    def __getattr__(cls, name):
        if _is_dunder(name):
            raise AttributeError(name)
        return _make_stub(name)


def _make_stub(name):
    return _StubMeta(name, (), {})


def _stub_getattr(name):
    if _is_dunder(name):
        raise AttributeError(name)
    return _make_stub(name)


class _TorchaoStub(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, name, path=None, target=None):
        if name == "torchao" or name.startswith("torchao."):
            return importlib.machinery.ModuleSpec(name, self)
        return None

    def create_module(self, spec):
        m = types.ModuleType(spec.name)
        m.__version__ = "0.0.0-stub"
        m.__file__ = "<torchao-stub>"
        m.__path__ = []
        m.__getattr__ = _stub_getattr
        return m

    def exec_module(self, module):
        pass


def install():
    if "torchao" not in sys.modules and not any(
        isinstance(f, _TorchaoStub) for f in sys.meta_path
    ):
        sys.meta_path.insert(0, _TorchaoStub())


install()
