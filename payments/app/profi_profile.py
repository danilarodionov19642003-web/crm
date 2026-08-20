from __future__ import annotations

import json
import re
from html import unescape
from html.parser import HTMLParser
from typing import Any
from urllib.parse import unquote, urlparse


PROFILE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{2,96}$")
AVATAR_RE = re.compile(
    r"(?:https?:)?//cdn\.profi\.ru/xfiles/pfiles/[^\"'<>\\\s]+\.(?:jpe?g|png|webp)",
    re.IGNORECASE,
)


class _JsonLdParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[str] = []
        self._collecting = False
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "script":
            return
        values = {str(key).lower(): str(value or "") for key, value in attrs}
        if values.get("type", "").lower() == "application/ld+json":
            self._collecting = True
            self._parts = []

    def handle_data(self, data: str) -> None:
        if self._collecting:
            self._parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script" and self._collecting:
            self.blocks.append("".join(self._parts))
            self._collecting = False
            self._parts = []


def normalize_profile_url(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("Укажите ссылку на анкету Profi.ru")
    if "://" not in raw:
        raw = f"https://{raw.lstrip('/')}"
    parsed = urlparse(raw)
    host = str(parsed.hostname or "").lower()
    if parsed.scheme.lower() not in {"http", "https"} or host not in {"profi.ru", "www.profi.ru"}:
        raise ValueError("Нужна ссылка вида https://profi.ru/profile/...")
    if parsed.port not in {None, 80, 443}:
        raise ValueError("Адрес Profi.ru содержит недопустимый порт")
    match = re.fullmatch(r"/profile/([^/]+)/?", unquote(parsed.path or ""), re.IGNORECASE)
    profile_id = match.group(1) if match else ""
    if not PROFILE_ID_RE.fullmatch(profile_id):
        raise ValueError("Не удалось определить код анкеты Profi.ru")
    return f"https://profi.ru/profile/{profile_id}/"


def _walk_json(value: Any):
    if isinstance(value, dict):
        yield value
        for nested in value.values():
            yield from _walk_json(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _walk_json(nested)


def _safe_avatar_url(value: Any) -> str:
    raw = unescape(str(value or "").strip()).replace("\\/", "/")
    if raw.startswith("//"):
        raw = f"https:{raw}"
    parsed = urlparse(raw)
    if parsed.scheme.lower() != "https" or str(parsed.hostname or "").lower() != "cdn.profi.ru":
        return ""
    if not parsed.path.startswith("/xfiles/pfiles/"):
        return ""
    if not re.search(r"\.(?:jpe?g|png|webp)$", parsed.path, re.IGNORECASE):
        return ""
    return raw


def extract_avatar_url(document: str) -> str:
    parser = _JsonLdParser()
    parser.feed(str(document or ""))
    for block in parser.blocks:
        try:
            payload = json.loads(block)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        for item in _walk_json(payload):
            avatar = _safe_avatar_url(item.get("logo"))
            if avatar:
                return avatar

    for match in AVATAR_RE.finditer(unescape(str(document or "")).replace("\\/", "/")):
        avatar = _safe_avatar_url(match.group(0))
        if avatar:
            return avatar
    return ""
