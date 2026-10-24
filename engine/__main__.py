import argparse
import ipaddress
import os

import uvicorn


def main():
    parser = argparse.ArgumentParser(description="Run the Fork local timeline engine")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    arguments = parser.parse_args()
    try:
        loopback = ipaddress.ip_address(arguments.host).is_loopback
    except ValueError:
        loopback = arguments.host.lower() == "localhost"
    if not loopback and not os.environ.get("PARADOX_TOKEN"):
        parser.error("Non-loopback binding requires PARADOX_TOKEN")
    uvicorn.run("engine.api:app", host=arguments.host, port=arguments.port)


if __name__ == "__main__":
    main()
