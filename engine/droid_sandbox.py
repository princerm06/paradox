import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid


EXECUTABLE = Path('/usr/bin/sandbox-exec')
PROFILE = Path(__file__).with_name('droid_adapter') / 'write_sandbox.sb'
MARKER = 'macos-write-v1'


def platform_reason():
    if sys.platform != 'darwin':
        return 'Droid requires the macOS write sandbox; no unsandboxed fallback is permitted'
    if not EXECUTABLE.is_file() or not os.access(EXECUTABLE, os.X_OK):
        return 'macOS sandbox-exec is unavailable; Droid is disabled'
    if not PROFILE.is_file():
        return 'Droid write sandbox profile is missing'
    return None


def availability_reason():
    reason = platform_reason()
    if reason:
        return reason
    try:
        with tempfile.TemporaryDirectory(prefix='paradox-sandbox-') as directory:
            target = str(Path(directory) / 'denied')
            script = 'import pathlib,sys\ntry: pathlib.Path(sys.argv[1]).write_text("denied")\nexcept PermissionError: sys.exit(0)\nsys.exit(1)'
            result = subprocess.run(
                [str(EXECUTABLE), '-p', '(version 1)(allow default)(deny file-write*)(deny network*)',
                 sys.executable, '-I', '-B', '-c', script, target],
                capture_output=True, timeout=5, env={'PATH': os.defpath},
            )
            if result.returncode or Path(target).exists():
                return 'Droid write sandbox failed its offline enforcement check'
    except (OSError, subprocess.TimeoutExpired):
        return 'Droid write sandbox could not initialize'
    return None


def prepare(code, command, environment):
    reason = platform_reason()
    if reason:
        raise RuntimeError(reason)
    code = Path(code).resolve(strict=True)
    app = code / 'demo_app'
    if app.is_symlink() or not app.is_dir():
        raise RuntimeError('Droid requires a real demo_app directory in its isolated future')
    operations = code.parent / ('.' + code.name + '-droid')
    home = operations / 'home'
    factory = home / '.factory'
    scratch = operations / 'tmp'
    for directory in (operations, home, factory, scratch):
        if directory.is_symlink():
            raise RuntimeError('Droid operational directories may not be symlinks')
        directory.mkdir(mode=0o700, exist_ok=True)
        directory.chmod(0o700)
    environment = dict(environment, HOME=str(home), TMPDIR=str(scratch),
                       PARADOX_DROID_SANDBOX=MARKER)
    prefix = [str(EXECUTABLE), '-D', 'APP=' + str(app), '-D', 'FACTORY=' + str(factory),
              '-D', 'SCRATCH=' + str(scratch), '-f', str(PROFILE)]
    outside = code / ('.sandbox-denied-' + uuid.uuid4().hex)
    inside = scratch / ('sandbox-allowed-' + uuid.uuid4().hex)
    script = (
        'import pathlib,sys\n'
        'pathlib.Path(sys.argv[1]).write_text("allowed")\n'
        'try: pathlib.Path(sys.argv[2]).write_text("denied")\n'
        'except PermissionError: sys.exit(0)\n'
        'sys.exit(1)'
    )
    try:
        probe_environment = {key: value for key, value in environment.items() if key != 'FACTORY_API_KEY'}
        result = subprocess.run(prefix + [sys.executable, '-I', '-B', '-c', script, str(inside), str(outside)],
                                capture_output=True, timeout=5, env=probe_environment)
        if result.returncode or outside.exists() or not inside.is_file():
            raise RuntimeError('Droid write sandbox enforcement failed; refusing to start the SDK')
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError('Droid write sandbox could not initialize; refusing to start the SDK') from error
    finally:
        inside.unlink(missing_ok=True)
        outside.unlink(missing_ok=True)
    return prefix + command, environment
