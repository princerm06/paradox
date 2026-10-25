import os
import selectors
import signal
import subprocess
import sys


def terminate(child):
    if child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=3)


def supervise(arguments):
    listener, status, code = arguments[:3]
    listener, status = int(listener), int(status)
    stopping = False

    def stop(signum, frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    child = None
    try:
        child = subprocess.Popen(arguments[3:], cwd=code, stdin=subprocess.DEVNULL,
                                 start_new_session=True, pass_fds=(listener,))
        os.close(listener)
        os.write(status, (str(child.pid) + "\n").encode("ascii"))
        os.close(status)
        with selectors.DefaultSelector() as selector:
            selector.register(0, selectors.EVENT_READ)
            while not stopping and child.poll() is None:
                if selector.select(.1):
                    os.read(0, 1)
                    stopping = True
    finally:
        if child is not None:
            terminate(child)
            returncode = child.wait()
        else:
            returncode = 1
    return returncode if returncode >= 0 else 128 - returncode


if __name__ == "__main__":
    sys.exit(supervise(sys.argv[1:]))
