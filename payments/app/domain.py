from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import hmac
from typing import Any


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
    else:
        client = _find_client(state, order.get("anketa_code"))
        if not client:
            raise PaymentApplyError(f"client not found for code {order.get('anketa_code')}")
        full_amount = money(order.get("amount"))
        paid_amount = expected_payment_amount(order)
        client["tariff"] = str(order.get("tariff_name") or client.get("tariff") or "")
        client["ordered"] = int(client.get("ordered") or 0) + int(order.get("qty") or 0)
        client["total"] = json_number(money(client.get("total")) + full_amount)
        client["paid"] = json_number(money(client.get("paid")) + paid_amount)
        client["remain"] = json_number(
            max(Decimal("0"), money(client.get("remain")) + full_amount - paid_amount)
        )
        allocations.append({"accountId": client.get("id"), "amount": json_number(paid_amount)})
        affected_codes.append(str(client.get("code") or ""))
        comment = "Оплата заказа (100%)" if bool(order.get("pay_full")) else "Предоплата заказа (50%)"

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
        "income": income,
    }


def refresh_financial_snapshot(payload: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    """Refresh financial fields for one portal without exposing the CRM blob."""
    result = deepcopy(payload)
    incomes = state.get("income", [])
    for anketa in result.get("anketas", []):
        client = _find_client(state, anketa.get("code"))
        if not client:
            continue
        for field in ("ordered", "paid", "remain", "total", "tariff"):
            anketa[field] = client.get(field, 0 if field != "tariff" else "")
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
