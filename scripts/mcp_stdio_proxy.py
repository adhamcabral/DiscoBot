#!/usr/bin/env python3
import subprocess
import sys
import threading


def pump(src, dst):
    try:
        while True:
            chunk = src.readline()
            if not chunk:
                break
            dst.write(chunk)
            dst.flush()
    except BrokenPipeError:
        pass
    finally:
        try:
            dst.close()
        except Exception:
            pass


def main():
    if len(sys.argv) < 2:
        print("usage: mcp_stdio_proxy.py <command> [args...]", file=sys.stderr)
        return 2

    child = subprocess.Popen(
        sys.argv[1:],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=sys.stderr.buffer,
    )

    stdin_thread = threading.Thread(target=pump, args=(sys.stdin.buffer, child.stdin), daemon=True)
    stdout_thread = threading.Thread(target=pump, args=(child.stdout, sys.stdout.buffer), daemon=True)
    stdin_thread.start()
    stdout_thread.start()

    try:
        return child.wait()
    except KeyboardInterrupt:
        child.terminate()
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
