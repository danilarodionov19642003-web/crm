from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import hashlib
import hmac
import re
from typing import Any
import uuid


class PaymentApplyError(ValueError):
    pass


def money(value: Any) -> Decimal:
    try:
        return Decimal(str(value or 0)).quantize(Decimal("0.01"))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise PaymentApplyError("invalid money value") from exc


def json_number(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral_value() else float(value)


def normalize_code(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "").replace(" ", "")


def expected_payment_amount(order: dict[str, Any]) -> Decimal:
    if order.get("order_type") == "remainder":
        amount = money(order.get("amount"))
    else:
        raw = order.get("prepay_amount")
        amount = money(order.get("amount") if raw is None else raw)
    if amount <= 0:
        raise PaymentApplyError("payment amount must be positive")
    return amount


def apply_flat_discount(items: list[dict[str, Any]], raw_discount: Any) -> Decimal:
    """Apply one order-level discount across package items and recalculate prepay."""
    total = sum((money(item.get("amount")) for item in items), money(0))
    remaining = min(max(money(0), money(raw_discount)), max(money(0), total - money(1)))
    applied = money(0)
    for item in items:
        base = money(item.get("amount"))
        part = min(remaining, max(money(0), base - money(1)))
        remaining -= part
        applied += part
        amount = base - part
        item["base_amount"] = json_number(base)
        item["discount_amount"] = json_number(part)
        item["amount"] = json_number(amount)
        prepay = amount if item.get("pay_full") else (
            amount / 2
        ).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        item["prepay_amount"] = json_number(prepay)
    return applied


def verify_webhook_signature(raw: bytes, timestamp: str, signature: str, secret: str) -> bool:
    if not timestamp or not signature or not secret:
        return False
    expected = hmac.new(
        secret.encode(),
        timestamp.encode() + b"." + raw,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def _find_client(state: dict[str, Any], code: Any) -> dict[str, Any] | None:
    wanted = normalize_code(code)
    if not wanted:
        return None
    return next(
        (client for client in state.get("clients", []) if normalize_code(client.get("code")) == wanted),
        None,
    )


def _already_applied(state: dict[str, Any], order_id: Any) -> bool:
    wanted = str(order_id)
    return any(str(item.get("clientOrderId") or "") == wanted for item in state.get("income", []))


def _next_client_number(state: dict[str, Any]) -> int:
    highest = 0
    for collection in (state.get("clients", []), state.get("mentors", [])):
        for item in collection:
            match = re.fullmatch(r"a(\d+)", normalize_code(item.get("code")))
            if match:
                highest = max(highest, int(match.group(1)))
    return highest + 1


def _stable_id(kind: str, order_id: Any, item_id: Any) -> str:
    seed = f"mentori:{kind}:{order_id}:{item_id}"
    return uuid.uuid5(uuid.NAMESPACE_URL, seed).hex


def _portal_for_email(state: dict[str, Any], email: Any) -> dict[str, Any] | None:
    wanted = str(email or "").strip().lower()
    return next(
        (
            portal for portal in state.get("clientPortals", [])
            if str(portal.get("email") or "").strip().lower() == wanted
        ),
        None,
    )


def _create_paid_client(
    state: dict[str, Any],
    order: dict[str, Any],
    item: dict[str, Any],
    code_number: int,
    paid_date: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    portal = _portal_for_email(state, order.get("client_email"))
    if not portal:
        raise PaymentApplyError("client portal not found for new card")

    item_id = item.get("item_id") or code_number
    code = f"a{code_number}"
    if _find_client(state, code):
        raise PaymentApplyError(f"generated client code already exists: {code}")

    name = str(item.get("anketa_name") or "").strip()
    if not name:
        raise PaymentApplyError("new card name is required")

    client = {
        "id": _stable_id("client", order.get("id"), item_id),
        "platform": "",
        "name": name,
        "code": code,
        "tariff": "",
        "ordered": 0,
        "done": 0,
        "paid": 0,
        "remain": 0,
        "total": 0,
        "allowRegularTariff": False,
        "date": paid_date,
        "deadline": "",
        "overdueDays": 0,
        "assignedEmail": str(order.get("client_email") or "").strip().lower(),
        "profileUrl": "",
        "avatarUrl": "",
        "avatarUpdatedAt": "",
    }
    mentor = {
        "id": _stable_id("mentor", order.get("id"), item_id),
        "code": code,
        "name": name,
        "profileUrl": "",
        "avatarUrl": "",
        "notes": "",
        "createdAt": paid_date,
    }
    state.setdefault("clients", []).append(client)
    state.setdefault("mentors", []).append(mentor)
    portal.setdefault("mentorIds", [])
    if mentor["id"] not in portal["mentorIds"]:
        portal["mentorIds"].append(mentor["id"])
    portal["updatedAt"] = paid_date
    return client, {
        "code": code,
        "name": name,
        "clientId": client["id"],
        "mentorId": mentor["id"],
    }


def _apply_package(client: dict[str, Any], item: dict[str, Any]) -> Decimal:
    full_amount = money(item.get("amount"))
    paid_amount = money(item.get("prepay_amount"))
    qty = int(item.get("qty") or 0)
    if full_amount <= 0 or paid_amount <= 0 or qty <= 0:
        raise PaymentApplyError("package values must be positive")
    client["tariff"] = str(item.get("tariff_name") or client.get("tariff") or "")
    client["ordered"] = int(client.get("ordered") or 0) + qty
    client["total"] = json_number(money(client.get("total")) + full_amount)
    client["paid"] = json_number(money(client.get("paid")) + paid_amount)
    client["remain"] = json_number(
        max(Decimal("0"), money(client.get("remain")) + full_amount - paid_amount)
    )
    return paid_amount


def apply_paid_order(
    state: dict[str, Any],
    order: dict[str, Any],
    provider_payment_id: str,
    paid_at: str | None = None,
) -> dict[str, Any]:
    """Apply one paid client order to the CRM blob.

    The caller must hold a database row lock for crm_state and update the
    payment transaction in the same SQL transaction.
    """
    order_id = order.get("id")
    if order_id is None:
        raise PaymentApplyError("order id is required")
    if _already_applied(state, order_id):
        return {"already_applied": True, "affected_codes": []}

    paid_at = paid_at or datetime.now(timezone.utc).isoformat()
    paid_date = paid_at[:10]
    allocations: list[dict[str, Any]] = []
    affected_codes: list[str] = []
    created_anketas: list[dict[str, Any]] = []
    package_items: list[dict[str, Any]] = []
    referral_bonus: dict[str, Any] | None = None

    if order.get("order_type") == "remainder":
        for raw_item in order.get("items") or []:
            amount = money(raw_item.get("amount"))
            if amount <= 0:
                continue
            client = _find_client(state, raw_item.get("code"))
            if not client:
                raise PaymentApplyError(f"client not found for code {raw_item.get('code')}")
            client["paid"] = json_number(money(client.get("paid")) + amount)
            client["remain"] = json_number(max(Decimal("0"), money(client.get("remain")) - amount))
            allocations.append({"accountId": client.get("id"), "amount": json_number(amount)})
            affected_codes.append(str(client.get("code") or ""))
        comment = "Доплата остатка"
    elif order.get("order_type") == "multi_order":
        raw_items = order.get("items") or []
        if not raw_items:
            raise PaymentApplyError("multi order has no package items")
        next_number = _next_client_number(state)
        for index, raw_item in enumerate(raw_items, start=1):
            item = dict(raw_item)
            created = None
            if item.get("is_new_anketa"):
                client, created = _create_paid_client(
                    state, order, item, next_number, paid_date
                )
                next_number += 1
                item["anketa_code"] = client["code"]
                item["anketa_name"] = client["name"]
                created_anketas.append(created)
            else:
                client = _find_client(state, item.get("anketa_code"))
                if not client:
                    raise PaymentApplyError(
                        f"client not found for code {item.get('anketa_code')}"
                    )
                item["anketa_code"] = client.get("code") or item.get("anketa_code")
                item["anketa_name"] = client.get("name") or item.get("anketa_name") or ""

            paid_amount = _apply_package(client, item)
            allocations.append({
                "accountId": client.get("id"),
                "amount": json_number(paid_amount),
            })
            affected_codes.append(str(client.get("code") or ""))
            package_items.append(item)
        order["items"] = package_items
        comment = "Оплата составного заказа"
    else:
        item = {
            "item_id": "single",
            "anketa_code": order.get("anketa_code"),
            "anketa_name": order.get("anketa_name"),
            "is_new_anketa": bool(order.get("is_new_anketa")),
            "tariff_name": order.get("tariff_name"),
            "qty": order.get("qty"),
            "amount": order.get("amount"),
            "prepay_amount": expected_payment_amount(order),
            "pay_full": bool(order.get("pay_full")),
        }
        if item["is_new_anketa"]:
            client, created = _create_paid_client(
                state, order, item, _next_client_number(state), paid_date
            )
            order["anketa_code"] = client["code"]
            created_anketas.append(created)
        else:
            client = _find_client(state, item["anketa_code"])
            if not client:
                raise PaymentApplyError(f"client not found for code {order.get('anketa_code')}")
        paid_amount = _apply_package(client, item)
        allocations.append({"accountId": client.get("id"), "amount": json_number(paid_amount)})
        affected_codes.append(str(client.get("code") or ""))
        comment = "Оплата заказа (100%)" if bool(order.get("pay_full")) else "Предоплата заказа (50%)"

    bonus_qty = int(order.get("_referral_bonus_qty") or 0)
    if bonus_qty not in (0, 1):
        raise PaymentApplyError("invalid referral bonus quantity")
    if bonus_qty:
        if order.get("order_type") == "remainder" or not affected_codes:
            raise PaymentApplyError("referral bonus has no target card")
        bonus_client = _find_client(state, affected_codes[0])
        if not bonus_client:
            raise PaymentApplyError("referral bonus target card not found")
        bonus_client["ordered"] = int(bonus_client.get("ordered") or 0) + bonus_qty
        referral_bonus = {
            "anketa_code": str(bonus_client.get("code") or affected_codes[0]),
            "anketa_name": str(bonus_client.get("name") or ""),
            "qty": bonus_qty,
        }

    if not allocations:
        raise PaymentApplyError("order has no payable items")

    income_amount = sum((money(item["amount"]) for item in allocations), Decimal("0"))
    names = []
    for item in allocations:
        client = next((c for c in state.get("clients", []) if c.get("id") == item.get("accountId")), None)
        if client:
            names.append(f"{client.get('code', '')} {client.get('name', '')}".strip())
    income = {
        "id": f"rollypay-order-{order_id}",
        "date": paid_date,
        "client": ", ".join(names),
        "service": "Отзывы",
        "amount": json_number(income_amount),
        "comment": comment,
        "source": "client_order",
        "clientOrderId": str(order_id),
        "providerPaymentId": provider_payment_id,
        "createdAt": paid_at,
        "items": allocations,
    }
    state.setdefault("income", []).append(income)
    return {
        "already_applied": False,
        "affected_codes": affected_codes,
        "created_anketas": created_anketas,
        "package_items": package_items,
        "referral_bonus": referral_bonus,
        "income": income,
    }


def refresh_financial_snapshot(payload: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    """Refresh financial fields for one portal without exposing the CRM blob."""
    result = deepcopy(payload)
    portal = _portal_for_email(state, result.get("email"))
    if portal:
        mentors = {str(item.get("id")): item for item in state.get("mentors", [])}
        existing_codes = {
            normalize_code(item.get("code")) for item in result.get("anketas", [])
        }
        for mentor_id in portal.get("mentorIds", []):
            mentor = mentors.get(str(mentor_id))
            if not mentor:
                continue
            code = normalize_code(mentor.get("code"))
            client = _find_client(state, code)
            if not client or not code or code in existing_codes:
                continue
            result.setdefault("anketas", []).append({
                "mentorId": mentor.get("id"),
                "code": client.get("code") or mentor.get("code") or "",
                "name": client.get("name") or mentor.get("name") or "",
                "platform": client.get("platform") or "",
                "profileUrl": client.get("profileUrl") or mentor.get("profileUrl") or "",
                "avatarUrl": client.get("avatarUrl") or mentor.get("avatarUrl") or "",
                "tariff": client.get("tariff") or "",
                "ordered": client.get("ordered") or 0,
                "done": client.get("manualDone") or 0,
                "paid": client.get("paid") or 0,
                "remain": client.get("remain") or 0,
                "total": client.get("total") or 0,
                "date": client.get("date") or "",
                "deadline": client.get("deadline") or "",
                "overdueDays": client.get("overdueDays") or 0,
                "schedule": client.get("schedule") or [],
                "weeklyPace": client.get("weeklyPace") or 0,
                "packageExtras": client.get("packageExtras") or [],
                "payments": [],
                "statuses": [],
                "reviews": [],
            })
            existing_codes.add(code)
    incomes = state.get("income", [])
    for anketa in result.get("anketas", []):
        client = _find_client(state, anketa.get("code"))
        if not client:
            continue
        for field in ("ordered", "paid", "remain", "total", "tariff"):
            anketa[field] = client.get(field, 0 if field != "tariff" else "")
        mentor = next(
            (
                item for item in state.get("mentors", [])
                if normalize_code(item.get("code")) == normalize_code(client.get("code"))
            ),
            None,
        ) or {}
        anketa["profileUrl"] = client.get("profileUrl") or mentor.get("profileUrl") or ""
        anketa["avatarUrl"] = client.get("avatarUrl") or mentor.get("avatarUrl") or ""
        payments = []
        for income in incomes:
            for item in income.get("items") or []:
                if item.get("accountId") != client.get("id"):
                    continue
                payments.append({
                    "incomeId": income.get("id"),
                    "date": income.get("date"),
                    "amount": item.get("amount") or 0,
                    "service": income.get("service") or "",
                    "comment": income.get("comment") or "",
                })
        payments.sort(key=lambda item: str(item.get("date") or ""), reverse=True)
        anketa["payments"] = payments

    totals = {"ordered": 0, "done": 0, "paid": 0, "remain": 0, "total": 0}
    for anketa in result.get("anketas", []):
        for field in totals:
            totals[field] += float(anketa.get(field) or 0)
    result["totals"] = {
        key: int(value) if value == int(value) else value
        for key, value in totals.items()
    }
    result["generatedAt"] = datetime.now(timezone.utc).isoformat()
    return result
