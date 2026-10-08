#!/usr/bin/env python3
"""Restore agent-eval.zip from Base64 using Python 3 standard library only."""
import argparse
import base64
import binascii
import hashlib
from pathlib import Path

EXPECTED_SHA256 = "fab622bcc802f5b9a0653c635a7a1f8be010c217b3d14933ae6a9062b2e5a9cb"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", type=Path,
                        default=Path(__file__).resolve().with_name("agent-eval.zip.base64"))
    parser.add_argument("-o", "--output", type=Path,
                        help="Output ZIP path (default: agent-eval.zip beside input)")
    args = parser.parse_args()
    output = args.output or args.input.with_name("agent-eval.zip")
    try:
        encoded = b"".join(args.input.read_bytes().split())
        decoded = base64.b64decode(encoded, validate=True)
        digest = hashlib.sha256(decoded).hexdigest()
        if digest != EXPECTED_SHA256:
            raise ValueError(f"SHA-256 mismatch: expected {EXPECTED_SHA256}, got {digest}")
        # Exclusive creation protects any existing ZIP from being overwritten.
        with output.open("xb") as stream:
            stream.write(decoded)
    except (OSError, ValueError, binascii.Error) as error:
        parser.exit(1, f"Error: {error}\n")
    print(f"Restored: {output} ({len(decoded)} bytes)")
    print(f"SHA-256 verified: {digest}")


if __name__ == "__main__":
    main()
