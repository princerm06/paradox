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
    if arguments[0] == "--job":
        control = int(arguments[1])
        listener = status = code = None
        command = arguments[2:]
        standard_input = None
    else:
        listener, status, code = arguments[:3]
        listener, status = int(listener), int(status)
        control = 0
        command = arguments[3:]
        standard_input = subprocess.DEVNULL
    stopping = False

    def stop(signum, frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    child = None
    try:
        child = subprocess.Popen(command, cwd=code, stdin=standard_input,
                                 start_new_session=True, pass_fds=(listener,) if listener is not None else ())
        if listener is not None:
            os.close(listener)
            os.write(status, (str(child.pid) + "\n").encode("ascii"))
            os.close(status)
        with selectors.DefaultSelector() as selector:
            selector.register(control, selectors.EVENT_READ)
            while not stopping and child.poll() is None:
                if selector.select(.1):
                    os.read(control, 1)
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
