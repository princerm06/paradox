"""Project Adapter v1: the frozen interface between the timeline engine and a project type.

Contract: docs/contracts/m2-projects.md. Changes need Claude, Codex 1 and Codex 2.

A profile is data. The engine (storage, runtime, validation, generations) reads every
project-specific path, command input and guard rule from it instead of hard-coding
`demo_app`. The demo keeps today's behaviour through DEMO_PROFILE; imported projects get
a profile built by the fastapi-sqlite-v1 adapter from a saved, validated AdapterConfig.

Profiles never carry argv or shell strings. Commands are fixed templates in engine code
that take these fields as arguments.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional, Protocol, Sequence, Tuple


@dataclass(frozen=True)
class ProjectProfile:
    adapter: str
    # Python import target served by uvicorn, relative to the code directory: "pkg.module:attr".
    app: str
    # Relative POSIX paths inside a timeline's code directory.
    compile_paths: Tuple[str, ...]
    tests: str
    # GET paths that must return 200 after boot. The first is the readiness probe.
    health_path: str
    smoke_paths: Tuple[str, ...]
    # The application finds its writable state directory through this variable.
    state_env: str
    # Guard. A change outside every editable prefix is rejected. "" means the whole tree.
    editable_prefixes: Tuple[str, ...]
    immutable_paths: Tuple[str, ...]
    # Files under this prefix that exist in the base are immutable (tests can be added, not edited).
    protected_tests_prefix: str
    # Recursive glob patterns relative to the state directory; matches are copied with the SQLite backup API.
    sqlite_state_globs: Tuple[str, ...]
    # "trusted_local" runs unsandboxed (bundled demo only). "sandboxed" requires the execution sandbox.
    execution: str
    # Agent providers allowed for this profile.
    providers: Tuple[str, ...]


DEMO_PROFILE = ProjectProfile(
    adapter="demo-v0",
    app="demo_app.main:app",
    compile_paths=("demo_app",),
    tests="demo_app/tests",
    health_path="/health",
    smoke_paths=("/health", "/api/posts"),
    state_env="PARADOX_APP_DIR",
    editable_prefixes=("demo_app/",),
    immutable_paths=("demo_app/AGENTS.md",),
    protected_tests_prefix="demo_app/tests/",
    sqlite_state_globs=("app.sqlite3",),  # demo: exactly today's file
    execution="trusted_local",
    providers=("scripted", "droid"),
)


@dataclass(frozen=True)
class Preflight:
    ok: bool
    # Diagnostic dicts in the M1 shape: {code, severity, message, path}.
    diagnostics: Sequence[Mapping[str, Optional[str]]]


class ProjectAdapter(Protocol):
    id: str

    def profile(self, configuration: Mapping[str, str]) -> ProjectProfile:
        """Build the profile from a saved AdapterConfig. Raises ValueError if it is not valid for this adapter."""

    def preflight(self, code: Path, profile: ProjectProfile) -> Preflight:
        """Static checks on an imported copy before anything executes (dependencies present in the
        engine interpreter, layout matches the profile). Never imports or runs project code."""

    def initialize_state(self, state: Path) -> None:
        """Create the initial, empty application state directory for the Original timeline."""
