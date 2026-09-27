"""Pure helper functions for Orion Water Meter."""

from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit


def normalize_url(value: str) -> str:
    """Normalize and validate an Orion Water Meter base URL."""
    url = value.strip().rstrip("/")
    lower_url = url.lower()
    if "://" in url and not lower_url.startswith(("http://", "https://")):
        raise ValueError("Invalid scheme")
    if not lower_url.startswith(("http://", "https://")):
        url = f"http://{url}"

    try:
        parsed = urlsplit(url)
        port = parsed.port
        hostname = parsed.hostname
    except ValueError as err:
        raise ValueError("Invalid URL") from err

    if (
        parsed.scheme not in {"http", "https"}
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Invalid URL")

    host = hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    netloc = f"{host}:{port}" if port is not None else host
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme.lower(), netloc, path, "", ""))
