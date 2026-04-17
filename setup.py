"""Cython build setup — compiles Python source to binary .pyd/.so files."""

import os
from setuptools import setup, Extension

# Only compile with Cython when SMARTCTX_COMPILE=1 (used in CI)
# Default: pure Python wheel (works everywhere)
USE_CYTHON = os.environ.get("SMARTCTX_COMPILE") == "1"

PACKAGE_DIR = os.path.join("python", "smartctx")

MODULES_TO_COMPILE = [
    "cli",
    "storage",
    "scanner",
    "summarizer",
    "query",
    "generator",
    "targets",
]


def get_extensions():
    if not USE_CYTHON:
        return []

    from Cython.Build import cythonize

    extensions = [
        Extension(
            f"smartctx.{mod}",
            [os.path.join(PACKAGE_DIR, f"{mod}.py")],
        )
        for mod in MODULES_TO_COMPILE
    ]

    return cythonize(
        extensions,
        compiler_directives={
            "language_level": "3",
            "boundscheck": False,
            "wraparound": False,
        },
    )


setup(
    ext_modules=get_extensions(),
)
