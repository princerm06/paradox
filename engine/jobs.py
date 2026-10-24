import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time


class Cancelled(Exception):
    pass


def scrubbed_environment(provider=None):
    environment = {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}
    if provider == "droid" and os.environ.get("FACTORY_API_KEY"):
        environment["FACTORY_API_KEY"] = os.environ["FACTORY_API_KEY"]
    if provider is None:
        environment.update(PYTHONDONTWRITEBYTECODE="1", PYTEST_DISABLE_PLUGIN_AUTOLOAD="1")
    return environment


def redact(text):
    for name in ("FACTORY_API_KEY", "PARADOX_TOKEN", "ANTHROPIC_API_KEY"):
        value = os.environ.get(name)
        if value:
            text = text.replace(value, "[REDACTED]")
    return text


class JobControl:
    def __init__(self):
        self.event = threading.Event()
        self.lock = threading.Lock()
        self.processes = set()

    def check(self):
        if self.event.is_set():
            raise Cancelled("Generation cancelled")

    def signal_process(self, process, sig):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass

    def stop_process(self, process):
        if process.poll() is None:
            self.signal_process(process, signal.SIGTERM)
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        self.signal_process(process, signal.SIGKILL)

    def cancel(self):
        self.event.set()
        with self.lock:
            for process in self.processes:
                self.signal_process(process, signal.SIGTERM)

    def run(self, command, cwd: Path, log_path: Path, timeout, environment=None, input_data=None):
        self.check()
        with log_path.open("ab") as output:
            death_read, death_write = os.pipe()
            launcher = (
                "import os,signal,subprocess,sys,threading; "
                "signal.signal(signal.SIGTERM,lambda *args: None); "
                "threading.Thread(target=lambda: (os.read(int(sys.argv[1]),1), os.killpg(os.getpgrp(),signal.SIGKILL)),daemon=True).start(); "
                "sys.exit(subprocess.call(sys.argv[2:]))"
            )
            try:
                process = subprocess.Popen(
                    [sys.executable, "-c", launcher, str(death_read), *command],
                    cwd=cwd, env=environment or scrubbed_environment(),
                    stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,
                    stdout=output, stderr=subprocess.STDOUT, start_new_session=True, pass_fds=(death_read,),
                )
            except BaseException:
                os.close(death_write)
                raise
            finally:
                os.close(death_read)
            with self.lock:
                self.processes.add(process)
                if self.event.is_set():
                    self.stop_process(process)
            try:
                if input_data is not None:
                    try:
                        process.stdin.write(input_data)
                    except BrokenPipeError:
                        pass
                    finally:
                        process.stdin.close()
                deadline = time.monotonic() + timeout
                while process.poll() is None:
                    self.check()
                    if time.monotonic() >= deadline:
                        raise TimeoutError(f"Process exceeded {timeout}s timeout")
                    time.sleep(0.05)
                self.check()
                return process.returncode
            finally:
                self.stop_process(process)
                process.wait(timeout=5)
                os.close(death_write)
                with self.lock:
                    self.processes.discard(process)


def log_line(path, message):
    with path.open("a", encoding="utf-8") as output:
        output.write(redact(message) + "\n")
