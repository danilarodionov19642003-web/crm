#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


STATE_DIR = Path("/var/lib/mentori-finance")
STATE_FILE = STATE_DIR / "finance-state.json"
MSK = ZoneInfo("Europe/Moscow")


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Не задана переменная {name}")
    return value


def config() -> dict[str, str]:
    return {
        "bot_token": required_env("BOT_TOKEN"),
        "chat_id": required_env("INFRA_CHAT_ID"),
        "thread_id": required_env("FINANCE_THREAD_ID"),
        "supabase_url": required_env("SUPABASE_URL").rstrip("/"),
        "supabase_key": required_env("SUPABASE_SERVICE_KEY"),
    }


def api_json(url: str, *, data: bytes | None = None,
             headers: dict[str, str] | None = None) -> Any:
    request = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            body = json.load(error)
            detail = body.get("description") or body.get("message") or f"HTTP {error.code}"
        except Exception:
            detail = f"HTTP {error.code}"
        raise RuntimeError(detail) from None


def telegram(cfg: dict[str, str], method: str, fields: dict[str, Any]) -> dict[str, Any]:
    body = urllib.parse.urlencode(fields).encode()
    result = api_json(
        f"https://api.telegram.org/bot{cfg['bot_token']}/{method}",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    if not result.get("ok"):
        raise RuntimeError(result.get("description") or "Telegram отклонил запрос")
    return result["result"]


def fetch_crm_state(cfg: dict[str, str]) -> dict[str, Any]:
    query = urllib.parse.urlencode({"id": "eq.main", "select": "data"})
    rows = api_json(
        f"{cfg['supabase_url']}/rest/v1/crm_state?{query}",
        headers={
            "apikey": cfg["supabase_key"],
            "Authorization": f"Bearer {cfg['supabase_key']}",
        },
    )
    if not rows or not isinstance(rows[0].get("data"), dict):
        raise RuntimeError("crm_state main пуст или недоступен")
    return rows[0]["data"]


def empty_delivery_state() -> dict[str, Any]:
    return {
        "version": 1,
        "initialized": False,
        "initialized_at": "",
        "records": {"income": {}, "expenses": {}},
        "last_balance_date": "",
    }


def load_delivery_state() -> dict[str, Any]:
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if isinstance(state, dict) and isinstance(state.get("records"), dict):
            state.setdefault("initialized", False)
            state.setdefault("last_balance_date", "")
            state["records"].setdefault("income", {})
            state["records"].setdefault("expenses", {})
            return state
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return empty_delivery_state()


def save_delivery_state(state: dict[str, Any]) -> None:
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix="finance-state.", dir=STATE_DIR)
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


def canonical(record: dict[str, Any]) -> str:
    return json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fingerprint(record: dict[str, Any]) -> str:
    return hashlib.sha256(canonical(record).encode("utf-8")).hexdigest()


def record_key(kind: str, record: dict[str, Any]) -> str:
    record_id = str(record.get("id") or "").strip()
    return f"{kind}:{record_id}" if record_id else f"{kind}:sha256:{fingerprint(record)}"


def money(value: Any) -> Decimal:
    try:
        return Decimal(str(value or 0))
    except (InvalidOperation, ValueError):
        return Decimal(0)


def format_money(value: Any) -> str:
    amount = money(value).quantize(Decimal("0.01"))
    if amount == amount.to_integral():
        result = f"{int(amount):,}"
    else:
        result = f"{amount:,.2f}"
    return result.replace(",", " ") + " ₽"


def clean(value: Any, fallback: str = "—") -> str:
    text = str(value or "").strip()
    return html.escape(text or fallback)


def source_name(value: Any) -> str:
    names = {
        "crm": "внесено вручную в CRM",
        "bot": "подтверждено через Telegram-бота",
        "client_order": "оплата из личного кабинета",
        "account_phone_auto": "автоматически при добавлении номера",
        "subscription_payment": "продление подписки",
        "employee_payment": "выплата сотруднику",
    }
    source = str(value or "crm").strip()
    return names.get(source, source or "CRM")


def income_text(record: dict[str, Any]) -> str:
    lines = [
        "📥 <b>НОВЫЙ ДОХОД</b>",
        f"💵 <b>{format_money(record.get('amount'))}</b>",
        f"📅 Дата: <b>{clean(record.get('date'))}</b>",
        f"👤 Клиент: <b>{clean(record.get('client'))}</b>",
        f"🧾 Услуга: {clean(record.get('service'))}",
        f"⚙️ Источник: {clean(source_name(record.get('source')))}",
    ]
    if str(record.get("comment") or "").strip():
        lines.append(f"💬 {clean(record.get('comment'))}")
    if record.get("id"):
        lines.append(f"🔎 ID: <code>{clean(record.get('id'))}</code>")
    return "\n".join(lines)


def expense_text(record: dict[str, Any]) -> str:
    expense_kind = "личный" if record.get("personal") else "рабочий"
    lines = [
        "📤 <b>НОВЫЙ РАСХОД</b>",
        f"💸 <b>{format_money(record.get('amount'))}</b>",
        f"📅 Дата: <b>{clean(record.get('date'))}</b>",
        f"🏷 Категория: <b>{clean(record.get('category'))}</b>",
        f"👛 Учёт: {expense_kind}",
        f"⚙️ Источник: {clean(source_name(record.get('source')))}",
    ]
    if str(record.get("comment") or "").strip():
        lines.append(f"💬 {clean(record.get('comment'))}")
    if record.get("id"):
        lines.append(f"🔎 ID: <code>{clean(record.get('id'))}</code>")
    return "\n".join(lines)


def send_message(cfg: dict[str, str], text: str) -> int:
    result = telegram(cfg, "sendMessage", {
        "chat_id": cfg["chat_id"],
        "message_thread_id": cfg["thread_id"],
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": "true",
    })
    return int(result["message_id"])


def edit_message(cfg: dict[str, str], message_id: int, text: str) -> None:
    try:
        telegram(cfg, "editMessageText", {
            "chat_id": cfg["chat_id"],
            "message_id": message_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": "true",
        })
    except RuntimeError as error:
        if "message is not modified" in str(error).casefold():
            return
        raise


def process_events(cfg: dict[str, str]) -> None:
    crm = fetch_crm_state(cfg)
    delivery = load_delivery_state()
    collections = {
        "income": [row for row in (crm.get("income") or []) if isinstance(row, dict)],
        "expenses": [row for row in (crm.get("expenses") or []) if isinstance(row, dict)],
    }

    if not delivery.get("initialized"):
        for kind, rows in collections.items():
            delivery["records"][kind] = {
                record_key(kind, row): {"fingerprint": fingerprint(row)} for row in rows
            }
        delivery["initialized"] = True
        delivery["initialized_at"] = datetime.now(MSK).isoformat()
        save_delivery_state(delivery)
        print(
            "Финансовый журнал принят за исходную точку: "
            f"доходов={len(collections['income'])}, расходов={len(collections['expenses'])}"
        )
        return

    for kind, rows in collections.items():
        stored = delivery["records"][kind]
        current_keys: set[str] = set()
        formatter = income_text if kind == "income" else expense_text
        for row in rows:
            key = record_key(kind, row)
            current_keys.add(key)
            row_fingerprint = fingerprint(row)
            text = formatter(row)
            previous = stored.get(key)
            if previous is None:
                message_id = send_message(cfg, text)
                stored[key] = {
                    "fingerprint": row_fingerprint,
                    "message_id": message_id,
                    "text": text,
                }
                save_delivery_state(delivery)
                continue
            if previous.get("fingerprint") == row_fingerprint:
                continue
            message_id = previous.get("message_id")
            if message_id:
                try:
                    edit_message(cfg, int(message_id), text + "\n\n✏️ <i>Запись обновлена в CRM</i>")
                except RuntimeError:
                    previous["message_id"] = send_message(
                        cfg,
                        text + "\n\n✏️ <i>Обновлённая запись CRM</i>",
                    )
            previous.update({"fingerprint": row_fingerprint, "text": text, "deleted": False})
            save_delivery_state(delivery)

        for key, previous in list(stored.items()):
            if key in current_keys or previous.get("deleted"):
                continue
            message_id = previous.get("message_id")
            old_text = previous.get("text")
            if message_id and old_text:
                try:
                    edit_message(
                        cfg,
                        int(message_id),
                        old_text + "\n\n🗑 <b>Эта запись удалена из CRM</b>",
                    )
                except RuntimeError:
                    pass
            previous["deleted"] = True
            save_delivery_state(delivery)


def is_after_balance(record: dict[str, Any], base_iso: str) -> bool:
    if not base_iso:
        return False
    created_at = str(record.get("createdAt") or "")
    if created_at:
        return created_at > base_iso
    return str(record.get("date") or "") > base_iso[:10]


def compute_current_balance(crm: dict[str, Any]) -> dict[str, Decimal | str]:
    finance = crm.get("finance") or {}
    base_iso = str(finance.get("balanceUpdatedAt") or "")
    confirmed = money(finance.get("balance"))
    income_after = sum(
        (money(row.get("amount")) for row in (crm.get("income") or [])
         if isinstance(row, dict) and is_after_balance(row, base_iso)),
        Decimal(0),
    )
    expense_after = sum(
        (money(row.get("amount")) for row in (crm.get("expenses") or [])
         if isinstance(row, dict) and is_after_balance(row, base_iso)),
        Decimal(0),
    )
    return {
        "confirmed": confirmed,
        "income_after": income_after,
        "expense_after": expense_after,
        "current": confirmed + income_after - expense_after,
        "base_iso": base_iso,
    }


def balance_text(crm: dict[str, Any], *, now: datetime | None = None,
                 heading: str = "БАЛАНС НА 23:00") -> str:
    now = now or datetime.now(MSK)
    today = now.date().isoformat()
    balance = compute_current_balance(crm)
    income_today = sum(
        (money(row.get("amount")) for row in (crm.get("income") or [])
         if isinstance(row, dict) and str(row.get("date") or "")[:10] == today),
        Decimal(0),
    )
    expense_today = sum(
        (money(row.get("amount")) for row in (crm.get("expenses") or [])
         if isinstance(row, dict) and str(row.get("date") or "")[:10] == today),
        Decimal(0),
    )
    base_iso = str(balance["base_iso"] or "")
    base_label = base_iso[:10] or "не сверялся"
    return "\n".join([
        f"🧮 <b>{heading}</b>",
        f"💰 Текущий баланс: <b>{format_money(balance['current'])}</b>",
        "",
        f"📥 Доходы за сегодня: <b>{format_money(income_today)}</b>",
        f"📤 Расходы за сегодня: <b>{format_money(expense_today)}</b>",
        f"✅ Последняя ручная сверка: {clean(base_label)} · {format_money(balance['confirmed'])}",
        "",
        "ℹ️ Расчёт сделан по текущим данным CRM. Баланс можно поправить в «Пульсе кэша».",
    ])


def send_balance(cfg: dict[str, str], *, force: bool = False) -> None:
    delivery = load_delivery_state()
    now = datetime.now(MSK)
    today = now.date().isoformat()
    if not force and delivery.get("last_balance_date") == today:
        print(f"Баланс за {today} уже отправлен")
        return
    crm = fetch_crm_state(cfg)
    heading = "КОНТРОЛЬНЫЙ БАЛАНС CRM" if force else "БАЛАНС НА 23:00"
    send_message(cfg, balance_text(crm, now=now, heading=heading))
    if not force:
        delivery["last_balance_date"] = today
        save_delivery_state(delivery)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("events", "balance", "balance-now"))
    args = parser.parse_args()
    cfg = config()
    if args.command == "events":
        process_events(cfg)
    elif args.command == "balance":
        send_balance(cfg)
    else:
        send_balance(cfg, force=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
