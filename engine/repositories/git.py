import os
from pathlib import Path
import selectors
import signal
import subprocess
import tempfile
import time

from engine import droid_sandbox


class RepositoryError(ValueError):
    def __init__(self, code, message, status=422):
        super().__init__(message)
        self.code = code
        self.status = status


class Git:
    def run(self, root, *arguments):
        try:
            return self.run_bytes(root, *arguments).decode("utf-8")
        except UnicodeDecodeError as error:
            raise RepositoryError("unsupported_filename", "Repository paths must be UTF-8") from error

    def run_bytes(self, root, *arguments, input_data=None, output_limit=4 * 1024 * 1024):
        if droid_sandbox.availability_reason():
            raise RepositoryError("sandbox_unavailable", "Read-only Git sandbox unavailable", 503)
        with tempfile.TemporaryDirectory(prefix="paradox-git-") as temporary:
            scratch = str(Path(temporary).resolve())
            environment = {"PATH": "/usr/bin:/bin", "HOME": scratch, "TMPDIR": scratch,
                           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                           "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C"}
            profile = ('(version 1)(allow default)(deny file-write*)(deny network*)(deny process-exec)'
                       '(allow process-exec (literal "/usr/bin/git") (literal "/usr/bin/xcrun")'
                       ' (literal "/Library/Developer/CommandLineTools/usr/bin/git")'
                       ' (literal "/Applications/Xcode.app/Contents/Developer/usr/bin/git"))'
                       '(allow file-write* (subpath (param "SCRATCH")) (literal "/dev/null"))')
            command = [str(droid_sandbox.EXECUTABLE), "-D", "SCRATCH=" + scratch, "-p", profile,
                       "/usr/bin/git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c",
                       "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null", "-c",
                       "core.pager=cat", "-c", "diff.external=", "-c", "protocol.allow=never",
                       "-C", str(root), *arguments]
            return self.capture(command, environment, input_data, output_limit)

    def capture(self, command, environment, input_data=None, output_limit=4 * 1024 * 1024):
        try:
            process = subprocess.Popen(command, env=environment, stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        except OSError as error:
            raise RepositoryError("git_failed", "Git inspection could not start") from error
        deadline = time.monotonic() + 10
        output = {"stdout": bytearray(), "stderr": bytearray()}
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ, "stdout")
                selector.register(process.stderr, selectors.EVENT_READ, "stderr")
                if input_data:
                    selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
                elif process.stdin:
                    process.stdin.close()
                pending = memoryview(input_data or b"")
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise RepositoryError("git_timeout", "Git inspection timed out")
                    for key, unused in selector.select(remaining):
                        if key.data == "stdin":
                            try:
                                written = os.write(key.fd, pending[:65536])
                            except BrokenPipeError:
                                written = len(pending)
                            pending = pending[written:]
                            if not pending:
                                selector.unregister(key.fileobj)
                                process.stdin.close()
                            continue
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        output[key.data].extend(chunk)
                        limit = output_limit if key.data == "stdout" else 4 * 1024 * 1024
                        if len(output[key.data]) > limit:
                            raise RepositoryError("repository_too_large", "Git output exceeds its size limit")
            if process.wait(timeout=max(0.01, deadline - time.monotonic())):
                raise RepositoryError("invalid_repository", "Not a readable Git working repository")
            return bytes(output["stdout"])
        except subprocess.TimeoutExpired as error:
            raise RepositoryError("git_timeout", "Git inspection timed out") from error
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            process.stdout.close()
            process.stderr.close()
            if process.stdin:
                process.stdin.close()

    def inspect(self, root):
        if root.resolve() != root or not root.is_dir() or (root / ".git").is_symlink() or not (root / ".git").is_dir():
            raise RepositoryError("unsafe_git_layout", "Registered repository location changed")
        if any((root / ".git" / name).is_symlink() for name in ("config", "HEAD", "index", "commondir")):
            raise RepositoryError("unsafe_git_metadata", "Symlink Git metadata is unsupported")
        if (root / ".git/commondir").exists():
            raise RepositoryError("unsupported_git_layout", "External common Git directories are unsupported")
        actual = self.run(root, "rev-parse", "--show-toplevel").rstrip("\n")
        if Path(actual).resolve() != root:
            raise RepositoryError("not_repository_root", "Select the Git working-tree top level")
        tracked = sorted(set(filter(None, self.run(root, "ls-files", "-z").split("\0"))))
        if len(tracked) > 10000:
            raise RepositoryError("repository_too_large", "At most 10000 tracked paths are supported")
        for path in tracked:
            if Path(path).is_absolute() or ".." in Path(path).parts:
                raise RepositoryError("unsafe_tracked_path", "Unsafe tracked filename")
        result = {"head": None, "branch": None, "detached": False, "dirty": False,
                  "staged": 0, "unstaged": 0, "untracked": 0, "conflicted": 0}
        records = iter(self.run(root, "status", "--porcelain=v2", "-z", "--branch", "--ignore-submodules=all").split("\0"))
        for record in records:
            if record.startswith("# branch.oid "):
                value = record[len("# branch.oid "):]
                result["head"] = None if value == "(initial)" else value
            elif record.startswith("# branch.head "):
                value = record[len("# branch.head "):]
                result["detached"] = value == "(detached)"
                result["branch"] = None if result["detached"] else value
            elif record.startswith(("1 ", "2 ", "u ")):
                status = record.split(" ", 2)[1]
                result["staged"] += status[0] != "."
                result["unstaged"] += status[1] != "."
                result["conflicted"] += record.startswith("u ")
                if record.startswith("2 "):
                    next(records, None)
            elif record.startswith("? "):
                result["untracked"] += 1
        result["dirty"] = any(result[name] for name in ("staged", "unstaged", "untracked", "conflicted"))
        return result, tracked
