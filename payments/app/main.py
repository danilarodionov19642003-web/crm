from __future__ import annotations

import hashlib
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

import httpx
import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from psycopg.rows import dict_row

from .domain import (
    PaymentApplyError,
    apply_paid_order,
    expected_payment_amount,
    money,
    refresh_financial_snapshot,
    verify_webhook_signature,
)


logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("mentori-payments")

DATABASE_URL = os.environ["DATABASE_URL"]
ROLLYPAY_API_KEY = os.environ["ROLLYPAY_API_KEY"]
ROLLYPAY_SIGNING_SECRET = os.environ["ROLLYPAY_SIGNING_SECRET"]
ROLLYPAY_TERMINAL_ID = os.environ["ROLLYPAY_TERMINAL_ID"]
ROLLYPAY_BASE_URL = os.getenv("ROLLYPAY_BASE_URL", "https://rollypay.io").rstrip("/")
GOTRUE_URL = os.getenv("GOTRUE_URL", "http://sup-gotrue:9999").rstrip("/")
FRONTEND_RETURN_URL = os.getenv(
    "FRONTEND_RETURN_URL", "https://app.mentori.tech/pages/client/index.html"
)
TEST_MODE = os.getenv("ROLLYPAY_TEST_MODE", "false").lower() in {"1", "true", "yes"}
OWNER_TELEGRAM_CHAT_ID = int(os.getenv("OWNER_TELEGRAM_CHAT_ID", "0") or 0)

app = FastAPI(title="Mentori Payments", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://app.mentori.tech"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


class CreatePaymentBody(BaseModel):
    client_order_id: int = Field(gt=0)


def db() -> psycopg.Connection:
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


async def current_user(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(
            f"{GOTRUE_URL}/user",
            headers={"Authorization": authorization},
        )
    if response.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid session")
    user = response.json()
    email = str(user.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=401, detail="Session has no email")
    user["email"] = email
    return user


def provider_headers() -> dict[str, str]:
    return {
        "X-API-Key": ROLLYPAY_API_KEY,
        "X-Nonce": str(uuid.uuid4()),
        "Content-Type": "application/json",
    }


def public_transaction(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "client_order_id": row.get("client_order_id"),
        "payment_id": row.get("provider_payment_id"),
        "status": row.get("status"),
        "pay_url": row.get("pay_url"),
        "environment": row.get("environment"),
        "expires_at": row.get("expires_at"),
        "business_applied": bool(row.get("business_applied_at")),
        "requires_manual_review": bool(row.get("requires_manual_review")),
    }


def active_transaction(conn: psycopg.Connection, order_id: int) -> dict[str, Any] | None:
    return conn.execute(
        """
        select * from public.payment_transactions
        where client_order_id = %s
          and status in ('initiating', 'created', 'processing')
          and (expires_at is null or expires_at > now())
        order by id desc limit 1
        """,
        (order_id,),
    ).fetchone()


def normalized_code(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "").replace(" ", "")


def canonicalize_order(
    conn: psycopg.Connection,
    order: dict[str, Any],
    email: str,
) -> dict[str, Any]:
    """Replace all client-supplied prices with values derived on the server."""
    snapshot_row = conn.execute(
        "select payload from public.client_snapshots where lower(email)=lower(%s)",
        (email,),
    ).fetchone()
    if not snapshot_row:
        raise HTTPException(status_code=409, detail="Client data is not ready for payment")
    snapshot = snapshot_row["payload"]
    if not order.get("offer_agreed") or not order.get("personal_data_agreed"):
        raise HTTPException(status_code=409, detail="Required agreements are missing")

    if order.get("order_type") == "remainder":
        requested = order.get("items") or []
        if not isinstance(requested, list) or not requested:
            raise HTTPException(status_code=409, detail="No remainder items selected")

        source_orders = conn.execute(
            """
            select * from public.client_orders
            where lower(client_email)=lower(%s) and order_type is distinct from 'remainder'
            """,
            (email,),
        ).fetchall()
        source_by_id = {str(row["id"]): row for row in source_orders}
        active_remainders = conn.execute(
            """
            select id,items from public.client_orders
            where lower(client_email)=lower(%s) and order_type='remainder'
              and status in ('new','confirmed') and id<>%s
            """,
            (email, order["id"]),
        ).fetchall()
        used_sources: set[str] = set()
        submitted_legacy: dict[str, Any] = {}
        for row in active_remainders:
            for item in row.get("items") or []:
                source_id = str(item.get("source_order_id") or "")
                if source_id:
                    used_sources.add(source_id)
                else:
                    code = normalized_code(item.get("code"))
                    submitted_legacy[code] = money(submitted_legacy.get(code)) + money(item.get("amount"))

        anketas = {
            normalized_code(item.get("code")): item
            for item in snapshot.get("anketas") or []
            if normalized_code(item.get("code"))
        }
        modern_by_code: dict[str, Any] = {}
        for source in source_orders:
            if source.get("status") != "confirmed" or source.get("remainder_status") != "pending":
                continue
            code = normalized_code(source.get("anketa_code"))
            outstanding = max(money(0), money(source.get("amount")) - money(source.get("prepay_amount")))
            modern_by_code[code] = money(modern_by_code.get(code)) + outstanding

        canonical_items: list[dict[str, Any]] = []
        seen_sources: set[str] = set()
        seen_legacy: set[str] = set()
        for item in requested:
            source_id = str(item.get("source_order_id") or "")
            if source_id:
                source = source_by_id.get(source_id)
                if (
                    not source
                    or source.get("status") != "confirmed"
                    or source.get("remainder_status") != "pending"
                    or source_id in used_sources
                    or source_id in seen_sources
                ):
                    raise HTTPException(status_code=409, detail="This remainder is no longer payable")
                amount = max(money(0), money(source.get("amount")) - money(source.get("prepay_amount")))
                if amount <= 0:
                    raise HTTPException(status_code=409, detail="This remainder is already closed")
                seen_sources.add(source_id)
                canonical_items.append({
                    "source_order_id": source_id,
                    "code": source.get("anketa_code") or "",
                    "name": source.get("anketa_name") or source.get("anketa_code") or "",
                    "label": source.get("anketa_name") or source.get("anketa_code") or "",
                    "amount": float(amount),
                })
                continue

            code = normalized_code(item.get("code"))
            anketa = anketas.get(code)
            if not anketa or code in seen_legacy:
                raise HTTPException(status_code=409, detail="This card remainder is no longer payable")
            available = max(
                money(0),
                money(anketa.get("remain"))
                - money(modern_by_code.get(code))
                - money(submitted_legacy.get(code)),
            )
            if available <= 0:
                raise HTTPException(status_code=409, detail="This card remainder is already closed")
            seen_legacy.add(code)
            canonical_items.append({
                "source_order_id": None,
                "code": anketa.get("code") or "",
                "name": anketa.get("name") or anketa.get("code") or "",
                "label": anketa.get("name") or anketa.get("code") or "",
                "amount": float(available),
            })

        total = sum((money(item["amount"]) for item in canonical_items), money(0))
        order.update({
            "items": canonical_items,
            "amount": total,
            "prepay_amount": total,
            "pay_full": True,
            "anketa_name": ", ".join(str(item["label"]) for item in canonical_items),
        })
    else:
        tariffs = (snapshot.get("payment") or {}).get("tariffs") or []
        selected = next(
            (
                tariff for tariff in tariffs
                if str(tariff.get("name") or "").strip().casefold()
                == str(order.get("tariff_name") or "").strip().casefold()
            ),
            None,
        )
        if not selected:
            raise HTTPException(status_code=409, detail="This tariff is not available")
        if selected.get("singleUse"):
            already_used = conn.execute(
                """
                select 1 from public.client_orders
                where lower(client_email)=lower(%s) and id<>%s
                  and lower(tariff_name)=lower(%s) and status<>'rejected'
                limit 1
                """,
                (email, order["id"], selected.get("name")),
            ).fetchone()
            if already_used:
                raise HTTPException(status_code=409, detail="This one-time tariff has already been used")
        price = money(selected.get("price"))
        if selected.get("unit") == "per":
            minimum = max(1, int(selected.get("qty") or 1))
            try:
                qty = int(order.get("qty") or 0)
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=409, detail="Invalid quantity") from exc
            if qty < minimum:
                raise HTTPException(status_code=409, detail="Quantity is below the tariff minimum")
            amount = price * qty
        else:
            qty = int(selected.get("qty") or 0)
            amount = price
        if qty <= 0 or amount <= 0:
            raise HTTPException(status_code=409, detail="Tariff configuration is invalid")

        if order.get("is_new_anketa"):
            if not str(order.get("anketa_name") or "").strip():
                raise HTTPException(status_code=409, detail="New card name is required")
        else:
            allowed_codes = {
                normalized_code(item.get("code")) for item in snapshot.get("anketas") or []
            }
            if normalized_code(order.get("anketa_code")) not in allowed_codes:
                raise HTTPException(status_code=409, detail="This card is not available")

        pay_full = True if selected.get("fullOnly") else bool(order.get("pay_full"))
        prepay = amount if pay_full else (amount / 2).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        order.update({
            "tariff_name": selected.get("name"),
            "tariff_price": price,
            "qty": qty,
            "amount": amount,
            "prepay_amount": prepay,
            "pay_full": pay_full,
        })

    saved = conn.execute(
        """
        update public.client_orders
        set anketa_name=%s, tariff_name=%s, tariff_price=%s, qty=%s, amount=%s,
            pay_full=%s, prepay_amount=%s, items=%s::jsonb
        where id=%s returning *
        """,
        (
            order.get("anketa_name"), order.get("tariff_name"), order.get("tariff_price"),
            order.get("qty"), order.get("amount"), order.get("pay_full"),
            order.get("prepay_amount"), json.dumps(order.get("items"), ensure_ascii=False),
            order["id"],
        ),
    ).fetchone()
    return saved


async def create_provider_payment(order: dict[str, Any], provider_order_id: str) -> dict[str, Any]:
    amount = expected_payment_amount(order)
    description = (
        "Доплата остатка Mentori"
        if order.get("order_type") == "remainder"
        else f"Mentori: {order.get('tariff_name') or 'заказ'}"
    )
    query = f"?payment=success&order={order['id']}"
    fail_query = f"?payment=failed&order={order['id']}"
    body = {
        "amount": f"{amount:.2f}",
        "payment_currency": "RUB",
        "order_id": provider_order_id,
        "terminal_id": ROLLYPAY_TERMINAL_ID,
        "description": description[:250],
        "customer_id": f"mentori-client-order-{order['id']}",
        "success_redirect_url": FRONTEND_RETURN_URL + query,
        "fail_redirect_url": FRONTEND_RETURN_URL + fail_query,
        "metadata": {"client_order_id": str(order["id"])},
        "test": TEST_MODE,
    }
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(
            f"{ROLLYPAY_BASE_URL}/api/v1/payments",
            headers=provider_headers(),
            json=body,
        )
    if response.status_code not in (200, 201):
        log.error("RollyPay create failed: status=%s body=%s", response.status_code, response.text[:500])
        raise HTTPException(status_code=502, detail="Payment provider is temporarily unavailable")
    return response.json()


@app.get("/health")
def health() -> dict[str, Any]:
    with db() as conn:
        conn.execute("select 1").fetchone()
    return {"ok": True, "provider": "rollypay", "test_mode": TEST_MODE}


@app.post("/create")
async def create_payment(body: CreatePaymentBody, user: dict[str, Any] = Depends(current_user)):
    with db() as conn:
        order = conn.execute(
            "select * from public.client_orders where id=%s",
            (body.client_order_id,),
        ).fetchone()
        if not order or str(order.get("client_email") or "").lower() != user["email"]:
            raise HTTPException(status_code=404, detail="Order not found")
        if order.get("status") == "confirmed":
            raise HTTPException(status_code=409, detail="Order is already paid")
        conn.execute(
            """
            update public.payment_transactions
            set status=case when status='initiating' then 'abandoned' else 'expired' end,
                updated_at=now()
            where client_order_id=%s
              and ((status='initiating' and created_at < now() - interval '2 minutes')
                or (status in ('created','processing') and expires_at <= now()))
            """,
            (body.client_order_id,),
        )
        current = active_transaction(conn, body.client_order_id)
        if current and current.get("pay_url"):
            return public_transaction(current)
        if current:
            raise HTTPException(status_code=409, detail="Payment is being created")
        order = canonicalize_order(conn, order, user["email"])
        provider_order_id = f"mentori-{body.client_order_id}-{uuid.uuid4().hex[:12]}"
        amount = expected_payment_amount(order)
        try:
            tx = conn.execute(
                """
                insert into public.payment_transactions
                  (client_order_id, client_email, provider_order_id, amount, currency,
                   status, environment)
                values (%s,%s,%s,%s,'RUB','initiating',%s)
                returning *
                """,
                (
                    body.client_order_id,
                    user["email"],
                    provider_order_id,
                    amount,
                    "sandbox" if TEST_MODE else "production",
                ),
            ).fetchone()
            conn.execute(
                """
                update public.client_orders
                set payment_provider='rollypay', payment_status='initiating',
                    payment_environment=%s, payment_created_at=coalesce(payment_created_at,now())
                where id=%s
                """,
                ("sandbox" if TEST_MODE else "production", body.client_order_id),
            )
            conn.commit()
        except psycopg.errors.UniqueViolation:
            conn.rollback()
            current = active_transaction(conn, body.client_order_id)
            if current and current.get("pay_url"):
                return public_transaction(current)
            raise HTTPException(status_code=409, detail="Payment is being created")

    try:
        provider = await create_provider_payment(order, provider_order_id)
    except Exception:
        with db() as conn:
            conn.execute(
                "update public.payment_transactions set status='create_failed', updated_at=now() where id=%s",
                (tx["id"],),
            )
            conn.execute(
                "update public.client_orders set payment_provider='rollypay', payment_status='create_failed' where id=%s",
                (body.client_order_id,),
            )
        raise

    with db() as conn:
        saved = conn.execute(
            """
            update public.payment_transactions
            set provider_payment_id=%s, status=%s, pay_url=%s,
                environment=%s, expires_at=%s, provider_payload=%s::jsonb, updated_at=now()
            where id=%s returning *
            """,
            (
                provider.get("payment_id"),
                provider.get("status") or "created",
                provider.get("pay_url"),
                provider.get("environment") or ("sandbox" if TEST_MODE else "production"),
                provider.get("expires_at"),
                json.dumps(provider, ensure_ascii=False),
                tx["id"],
            ),
        ).fetchone()
        conn.execute(
            """
            update public.client_orders
            set payment_provider='rollypay', payment_id=%s, payment_status=%s,
                payment_url=%s, payment_environment=%s, payment_created_at=now()
            where id=%s
            """,
            (
                provider.get("payment_id"),
                provider.get("status") or "created",
                provider.get("pay_url"),
                provider.get("environment") or ("sandbox" if TEST_MODE else "production"),
                body.client_order_id,
            ),
        )
        return public_transaction(saved)


def refresh_snapshot(conn: psycopg.Connection, email: str, state: dict[str, Any]) -> None:
    row = conn.execute(
        "select payload from public.client_snapshots where lower(email)=lower(%s) for update",
        (email,),
    ).fetchone()
    if not row:
        return
    payload = refresh_financial_snapshot(row["payload"], state)
    conn.execute(
        "update public.client_snapshots set payload=%s::jsonb, updated_at=now() where lower(email)=lower(%s)",
        (json.dumps(payload, ensure_ascii=False), email),
    )


def notify_paid_order(
    conn: psycopg.Connection,
    order: dict[str, Any],
    amount: Any,
    manual_review: bool = False,
) -> None:
    if not OWNER_TELEGRAM_CHAT_ID:
        return
    target = str(order.get("anketa_code") or order.get("anketa_name") or "—")
    suffix = "\n⚠ Нужна ручная привязка заказа к карточке." if manual_review else "\n✅ CRM и финансы обновлены автоматически."
    message = (
        "💳 Онлайн-оплата получена!\n"
        f"👤 {order.get('client_name') or order.get('client_email') or 'клиент'}\n"
        f"Анкета: {target}\n"
        f"Сумма: {money(amount):.0f} ₽"
        f"{suffix}"
    )
    conn.execute(
        """
        insert into public.notification_outbox
          (telegram_chat_id,kind,message,status,mentor_id,client_email)
        values (%s,'payment_paid',%s,'pending',%s,%s)
        """,
        (
            OWNER_TELEGRAM_CHAT_ID,
            message,
            str(order.get("id") or ""),
            order.get("client_email"),
        ),
    )


def apply_provider_status(provider: dict[str, Any]) -> dict[str, Any]:
    payment_id = str(provider.get("payment_id") or "")
    provider_order_id = str(provider.get("order_id") or "")
    status = str(provider.get("status") or "")
    if not payment_id and not provider_order_id:
        return {"ignored": True, "reason": "payment reference missing"}

    with db() as conn:
        tx = conn.execute(
            """
            select * from public.payment_transactions
            where provider_payment_id=%s or provider_order_id=%s
            order by id desc limit 1 for update
            """,
            (payment_id, provider_order_id),
        ).fetchone()
        if not tx:
            return {"ignored": True, "reason": "unknown payment"}
        if provider.get("amount") is not None and money(provider.get("amount")) != money(tx["amount"]):
            raise PaymentApplyError("provider amount mismatch")
        currency = str(provider.get("currency") or provider.get("payment_currency") or "RUB")
        if currency != tx["currency"]:
            raise PaymentApplyError("provider currency mismatch")

        conn.execute(
            """
            update public.payment_transactions
            set provider_payment_id=coalesce(provider_payment_id,%s), status=%s,
                provider_payload=%s::jsonb, paid_at=case when %s='paid' then coalesce(paid_at,now()) else paid_at end,
                updated_at=now(), requires_manual_review=case when %s in ('refunded','chargeback') then true else requires_manual_review end
            where id=%s
            """,
            (payment_id or None, status, json.dumps(provider, ensure_ascii=False), status, status, tx["id"]),
        )
        conn.execute(
            """
            update public.client_orders
            set payment_status=%s,
                payment_paid_at=case when %s='paid' then coalesce(payment_paid_at,now()) else payment_paid_at end
            where id=%s
            """,
            (status, status, tx["client_order_id"]),
        )

        if status != "paid" or tx.get("business_applied_at"):
            return {"ok": True, "status": status, "applied": bool(tx.get("business_applied_at"))}
        if tx.get("environment") == "sandbox" or bool(provider.get("test")):
            return {"ok": True, "status": status, "applied": False, "sandbox": True}

        order = conn.execute(
            "select * from public.client_orders where id=%s for update",
            (tx["client_order_id"],),
        ).fetchone()
        if not order:
            raise PaymentApplyError("client order not found")
        if order.get("status") == "confirmed":
            conn.execute(
                "update public.payment_transactions set business_applied_at=now(), apply_note='order_already_confirmed' where id=%s",
                (tx["id"],),
            )
            return {"ok": True, "status": status, "applied": False, "already_confirmed": True}

        state_row = conn.execute(
            "select data from public.crm_state where id='main' for update"
        ).fetchone()
        if not state_row:
            raise PaymentApplyError("crm state not found")
        state = state_row["data"]
        try:
            applied = apply_paid_order(
                state,
                order,
                payment_id or str(tx.get("provider_payment_id") or ""),
                str(provider.get("paid_at") or datetime.now(timezone.utc).isoformat()),
            )
        except PaymentApplyError as exc:
            conn.execute(
                "update public.payment_transactions set requires_manual_review=true, apply_note=%s where id=%s",
                (str(exc), tx["id"]),
            )
            notify_paid_order(conn, order, tx["amount"], manual_review=True)
            log.error("Paid payment requires manual review: tx=%s error=%s", tx["id"], exc)
            return {"ok": True, "status": status, "applied": False, "manual_review": True}

        conn.execute(
            "update public.crm_state set data=%s::jsonb, updated_at=now() where id='main'",
            (json.dumps(state, ensure_ascii=False),),
        )
        if order.get("order_type") == "remainder":
            source_ids = [
                str(item.get("source_order_id"))
                for item in order.get("items") or []
                if item.get("source_order_id")
            ]
            if source_ids:
                conn.execute(
                    "update public.client_orders set remainder_status=null where id = any(%s::bigint[])",
                    (source_ids,),
                )
            remainder_status = None
        else:
            full = money(order.get("amount"))
            paid = expected_payment_amount(order)
            remainder_status = None if bool(order.get("pay_full")) or paid >= full else "pending"
        conn.execute(
            """
            update public.client_orders
            set status='confirmed', confirmed_at=coalesce(confirmed_at,now()), remainder_status=%s,
                payment_status='paid', payment_paid_at=coalesce(payment_paid_at,now())
            where id=%s
            """,
            (remainder_status, order["id"]),
        )
        conn.execute(
            "update public.payment_transactions set business_applied_at=now(), apply_note='applied' where id=%s",
            (tx["id"],),
        )
        refresh_snapshot(conn, str(order.get("client_email") or ""), state)
        notify_paid_order(conn, order, tx["amount"])
        return {"ok": True, "status": status, "applied": not applied.get("already_applied")}


async def fetch_provider_payment(payment_id: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(
            f"{ROLLYPAY_BASE_URL}/api/v1/payments/{payment_id}",
            headers=provider_headers(),
        )
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="Unable to check payment status")
    return response.json()


@app.get("/orders/{order_id}")
async def payment_status(order_id: int, user: dict[str, Any] = Depends(current_user)):
    with db() as conn:
        order = conn.execute(
            "select id,client_email,status from public.client_orders where id=%s",
            (order_id,),
        ).fetchone()
        if not order or str(order.get("client_email") or "").lower() != user["email"]:
            raise HTTPException(status_code=404, detail="Order not found")
        tx = conn.execute(
            "select * from public.payment_transactions where client_order_id=%s order by id desc limit 1",
            (order_id,),
        ).fetchone()
    if not tx:
        raise HTTPException(status_code=404, detail="Payment not found")
    if tx.get("provider_payment_id") and tx.get("status") in {"initiating", "created", "processing"}:
        provider = await fetch_provider_payment(tx["provider_payment_id"])
        apply_provider_status(provider)
        with db() as conn:
            tx = conn.execute(
                "select * from public.payment_transactions where id=%s",
                (tx["id"],),
            ).fetchone()
    return public_transaction(tx)


@app.post("/rollypay/callback")
async def rollypay_callback(request: Request):
    raw = await request.body()
    signature = request.headers.get("X-Signature", "")
    timestamp = request.headers.get("X-Timestamp", "")
    if not signature or not timestamp:
        raise HTTPException(status_code=403, detail="Missing signature")
    if not verify_webhook_signature(raw, timestamp, signature, ROLLYPAY_SIGNING_SECRET):
        raise HTTPException(status_code=403, detail="Invalid signature")
    try:
        event = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON") from exc

    event_key = hashlib.sha256(raw).hexdigest()
    with db() as conn:
        exists = conn.execute(
            "select 1 from public.payment_webhook_events where event_key=%s",
            (event_key,),
        ).fetchone()
    if exists:
        return {"ok": True, "duplicate": True}
    try:
        result = apply_provider_status(event)
    except PaymentApplyError as exc:
        log.error("Rejected signed callback: %s", exc)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    with db() as conn:
        conn.execute(
            """
            insert into public.payment_webhook_events
              (event_key,event_type,provider_payment_id,provider_timestamp,payload)
            values (%s,%s,%s,%s,%s::jsonb)
            on conflict (event_key) do nothing
            """,
            (
                event_key,
                event.get("event_type"),
                event.get("payment_id"),
                timestamp,
                json.dumps(event, ensure_ascii=False),
            ),
        )
    return result
