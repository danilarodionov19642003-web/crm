#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


STORAGE_ROOT = Path("/var/lib/docker/volumes/supabase_sup-storage/_data/stub/stub/receipts")
STATE_DIR = Path("/var/lib/mentori-receipts")
STATE_FILE = STATE_DIR / "sent-state.json"
MAX_DOCUMENT_BYTES = 49 * 1024 * 1024
MSK = ZoneInfo("Europe/Moscow")


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Не задана переменная {name}")
    return value


BOT_TOKEN = required_env("BOT_TOKEN")
CHAT_ID = required_env("INFRA_CHAT_ID")
THREAD_ID = required_env("RECEIPTS_THREAD_ID")
SUPABASE_URL = required_env("SUPABASE_URL").rstrip("/")
SUPABASE_KEY = required_env("SUPABASE_SERVICE_KEY")


def api_json(url: str, *, data: bytes | None = None, headers: dict[str, str] | None = None) -> Any:
    request = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            body = json.load(error)
            detail = body.get("description") or body.get("message") or f"HTTP {error.code}"
        except Exception:
            detail = f"HTTP {error.code}"
        raise RuntimeError(detail) from None


def telegram(method: str, fields: dict[str, Any]) -> dict[str, Any]:
    body = urllib.parse.urlencode(fields).encode()
    result = api_json(
        f"https://api.telegram.org/bot{BOT_TOKEN}/{method}",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    if not result.get("ok"):
        raise RuntimeError(result.get("description") or "Telegram отклонил запрос")
    return result["result"]


def send_document(path: Path, filename: str, caption: str) -> dict[str, Any]:
    boundary = f"----MentoriReceipt{os.urandom(12).hex()}"
    chunks: list[bytes] = []
    for name, value in {
        "chat_id": CHAT_ID,
        "message_thread_id": THREAD_ID,
        "caption": caption,
    }.items():
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            str(value).encode("utf-8"),
            b"\r\n",
        ])
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    chunks.extend([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="document"; filename="{filename}"\r\n'.encode(),
        f"Content-Type: {mime}\r\n\r\n".encode(),
        path.read_bytes(),
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    result = api_json(
        f"https://api.telegram.org/bot{BOT_TOKEN}/sendDocument",
        data=b"".join(chunks),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    if not result.get("ok"):
        raise RuntimeError(result.get("description") or "Telegram не принял чек")
    return result["result"]


def load_state() -> dict[str, Any]:
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("sent"), dict):
            return data
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return {"version": 1, "sent": {}}


def save_state(state: dict[str, Any]) -> None:
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix="sent-state.", dir=STATE_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(state, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, STATE_FILE)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def fetch_orders() -> list[dict[str, Any]]:
    fields = (
        "id,client_name,client_email,anketa_code,anketa_name,tariff_name,qty,amount,"
        "prepay_amount,status,created_at,confirmed_at,payment_paid_at,payment_method,"
        "payment_provider,order_type,items,receipt_url"
    )
    query = urllib.parse.urlencode({
        "select": fields,
        "receipt_url": "not.is.null",
        "status": "in.(new,confirmed)",
        "order": "created_at.asc,id.asc",
    })
    rows = api_json(
        f"{SUPABASE_URL}/rest/v1/client_orders?{query}",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
        },
    )
    return [row for row in rows if str(row.get("receipt_url") or "").strip()]


def object_name(reference: str) -> str:
    marker = "/receipts/"
    if reference.startswith("storage://receipts/"):
        return urllib.parse.unquote(reference[len("storage://receipts/"):]).split("?", 1)[0]
    if marker in reference:
        return urllib.parse.unquote(reference.split(marker, 1)[1]).split("?", 1)[0]
    raise RuntimeError(f"Неизвестная ссылка на чек: {reference[:120]}")


def object_file(name: str) -> Path:
    directory = STORAGE_ROOT.joinpath(*Path(name).parts)
    if not directory.is_dir():
        raise RuntimeError(f"Файл чека отсутствует в Storage: {name}")
    files = [path for path in directory.iterdir() if path.is_file()]
    if len(files) != 1:
        raise RuntimeError(f"У объекта чека найдено файлов: {len(files)} ({name})")
    return files[0]


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def money(value: Any) -> Decimal:
    try:
        return Decimal(str(value or 0))
    except (InvalidOperation, ValueError):
        return Decimal(0)


def format_money(value: Decimal) -> str:
    rounded = value.quantize(Decimal("0.01"))
    if rounded == rounded.to_integral():
        text = f"{int(rounded):,}"
    else:
        text = f"{rounded:,.2f}"
    return text.replace(",", " ") + " ₽"


def format_date(rows: list[dict[str, Any]]) -> str:
    candidates: list[datetime] = []
    for row in rows:
        raw = row.get("payment_paid_at") or row.get("confirmed_at") or row.get("created_at")
        if not raw:
            continue
        try:
            candidates.append(datetime.fromisoformat(str(raw).replace("Z", "+00:00")))
        except ValueError:
            pass
    if not candidates:
        return "дата не указана"
    value = max(candidates)
    if value.tzinfo is None:
        value = value.replace(tzinfo=MSK)
    return value.astimezone(MSK).strftime("%d.%m.%Y %H:%M")


def normalized_code(value: Any) -> str:
    text = str(value or "").strip().upper()
    return text if text else "БЕЗ КОДА"


def item_lines(rows: list[dict[str, Any]]) -> list[str]:
    lines: list[str] = []
    for row in rows:
        items = row.get("items") if isinstance(row.get("items"), list) else []
        if items:
            for item in items:
                code = normalized_code(item.get("anketa_code"))
                name = str(item.get("anketa_name") or "анкета").strip()
                tariff = str(item.get("tariff_name") or "тариф").strip()
                qty = int(item.get("qty") or 0)
                paid = money(item.get("prepay_amount") or item.get("amount"))
                lines.append(f"• {code} · {name} — {tariff}, {qty} шт., оплачено {format_money(paid)}")
        else:
            code = normalized_code(row.get("anketa_code"))
            name = str(row.get("anketa_name") or "анкета").strip()
            tariff = str(row.get("tariff_name") or "тариф").strip()
            qty = int(row.get("qty") or 0)
            paid = money(row.get("prepay_amount") or row.get("amount"))
            lines.append(f"• {code} · {name} — {tariff}, {qty} шт., оплачено {format_money(paid)}")
    return lines


def caption_for(rows: list[dict[str, Any]]) -> str:
    clients = sorted({str(row.get("client_name") or row.get("client_email") or "Клиент").strip() for row in rows})
    paid_total = sum((money(row.get("prepay_amount") or row.get("amount")) for row in rows), Decimal(0))
    order_ids = ", ".join(f"#{row['id']}" for row in rows)
    confirmed = all(row.get("status") == "confirmed" for row in rows)
    status = "✅ подтверждён" if confirmed else "🟡 ожидает подтверждения"
    lines = [
        "🧾 ЧЕК ОБ ОПЛАТЕ",
        f"📅 Дата: {format_date(rows)}",
        f"👤 Клиент: {', '.join(clients)}",
        "📦 Оплаченные тарифы:",
        *item_lines(rows),
        f"💰 Всего по чеку: {format_money(paid_total)}",
        "💳 Способ оплаты: перевод по реквизитам",
        f"📌 Статус: {status}",
        f"🆔 Заказ: {order_ids}",
    ]
    caption = "\n".join(lines)
    if len(caption) > 1000:
        raise RuntimeError(f"Подпись чека слишком длинная: {order_ids}")
    return caption


def safe_filename(rows: list[dict[str, Any]], object_path: str) -> str:
    suffix = Path(object_path).suffix.lower() or ".bin"
    date = format_date(rows)[:10].split(".")
    date_part = "-".join(reversed(date)) if len(date) == 3 else "unknown-date"
    codes = "-".join(sorted({normalized_code(row.get("anketa_code")) for row in rows}))
    codes = re.sub(r"[^A-Z0-9-]+", "-", codes).strip("-") or "CLIENT"
    return f"receipt_{date_part}_{codes}{suffix}"


def caption_fingerprint(caption: str, sha256: str) -> str:
    return hashlib.sha256(f"{sha256}\n{caption}".encode("utf-8")).hexdigest()


def edit_caption(message_id: int, caption: str) -> None:
    telegram("editMessageCaption", {
        "chat_id": CHAT_ID,
        "message_id": message_id,
        "caption": caption,
    })


def main() -> int:
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    state = load_state()
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in fetch_orders():
        grouped[object_name(str(row["receipt_url"]))].append(row)

    sent_count = 0
    updated_count = 0
    for name, rows in sorted(grouped.items(), key=lambda item: format_date(item[1])):
        path = object_file(name)
        if path.stat().st_size > MAX_DOCUMENT_BYTES:
            raise RuntimeError(f"Чек больше лимита Telegram 49 МБ: {name}")
        sha256 = file_sha256(path)
        caption = caption_for(rows)
        fingerprint = caption_fingerprint(caption, sha256)
        previous = state["sent"].get(name) or {}
        if previous.get("fingerprint") == fingerprint:
            continue

        message_id = previous.get("message_id")
        if message_id and previous.get("sha256") == sha256:
            try:
                edit_caption(int(message_id), caption)
                updated_count += 1
            except RuntimeError:
                message_id = None

        if not message_id:
            message = send_document(path, safe_filename(rows, name), caption)
            message_id = int(message["message_id"])
            sent_count += 1

        state["sent"][name] = {
            "fingerprint": fingerprint,
            "message_id": message_id,
            "order_ids": [int(row["id"]) for row in rows],
            "sha256": sha256,
            "updated_at": datetime.now(MSK).isoformat(),
        }
        save_state(state)

    print(f"Чеки: отправлено {sent_count}, обновлено {updated_count}, всего в реестре {len(state['sent'])}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Ошибка отправки чеков: {error}", file=sys.stderr)
        raise SystemExit(1)
