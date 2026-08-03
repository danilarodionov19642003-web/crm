import asyncio
import inspect
import os
import unittest
from unittest.mock import patch

from fastapi import HTTPException


os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")
os.environ.setdefault("ROLLYPAY_API_KEY", "test")
os.environ.setdefault("ROLLYPAY_SIGNING_SECRET", "test")
os.environ.setdefault("ROLLYPAY_TERMINAL_ID", "test")

from app import main  # noqa: E402


class CaptureConnection:
    def __init__(self):
        self.calls = []

    def execute(self, query, params):
        self.calls.append((query, params))
        if query.count("%s") != len(params):
            raise AssertionError(
                f"SQL placeholders={query.count('%s')} params={len(params)}"
            )


class QueryResult:
    def __init__(self, one=None, many=None):
        self.one = one
        self.many = many or []

    def fetchone(self):
        return self.one

    def fetchall(self):
        return self.many


class CancelConnection:
    def __init__(self, order, transactions):
        self.order = order
        self.transactions = transactions
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, query, params):
        self.calls.append((query, params))
        normalized = " ".join(query.split()).lower()
        if normalized.startswith("select * from public.payment_transactions"):
            return QueryResult(many=self.transactions)
        if normalized.startswith("select * from public.client_orders"):
            return QueryResult(one=self.order)
        return QueryResult()


class PaymentMainTest(unittest.TestCase):
    def test_package_child_insert_has_matching_sql_parameters(self):
        conn = CaptureConnection()
        order = {
            "id": 10,
            "client_email": "client@example.com",
            "client_name": "Клиент",
            "payment_method": "card_transfer",
            "offer_agreed": True,
            "personal_data_agreed": True,
        }
        item = {
            "item_id": "10-1",
            "anketa_code": "a1",
            "anketa_name": "Анкета",
            "tariff_name": "Экспресс",
            "tariff_price": 4800,
            "qty": 3,
            "amount": 4500,
            "prepay_amount": 2250,
            "discount_amount": 300,
            "pay_full": False,
        }
        main.insert_package_children(
            conn,
            order,
            [item],
            "manual-10",
            "2026-07-20T10:00:00+00:00",
            payment_provider="manual_transfer",
        )
        self.assertEqual(len(conn.calls), 1)

    def test_only_owner_can_confirm_manual_transfer(self):
        self.assertTrue(main.is_owner({"app_metadata": {"role": "owner"}}))
        self.assertFalse(main.is_owner({"app_metadata": {"role": "team"}}))
        self.assertFalse(
            main.is_owner({
                "app_metadata": {"role": "client"},
                "user_metadata": {"role": "owner"},
            })
        )

    def test_owner_can_cancel_unpaid_online_order_without_deleting_audit_rows(self):
        conn = CancelConnection(
            order={
                "id": 42,
                "status": "new",
                "payment_provider": "rollypay",
                "payment_status": "processing",
            },
            transactions=[{
                "id": 7,
                "status": "processing",
                "business_applied_at": None,
            }],
        )
        with patch.object(main, "db", return_value=conn):
            result = asyncio.run(main.cancel_online_order(
                main.CancelOrderBody(client_order_id=42),
                {"app_metadata": {"role": "owner"}},
            ))

        self.assertTrue(result["ok"])
        self.assertEqual(result["payment_status"], "canceled")
        sql = "\n".join(query for query, _ in conn.calls).lower()
        self.assertIn("set status='canceled'", sql)
        self.assertIn("set status='rejected'", sql)
        self.assertNotIn("delete from", sql)

    def test_paid_online_order_cannot_be_canceled(self):
        conn = CancelConnection(
            order={
                "id": 42,
                "status": "new",
                "payment_provider": "rollypay",
                "payment_status": "paid",
            },
            transactions=[{
                "id": 7,
                "status": "paid",
                "business_applied_at": None,
            }],
        )
        with patch.object(main, "db", return_value=conn):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(main.cancel_online_order(
                    main.CancelOrderBody(client_order_id=42),
                    {"app_metadata": {"role": "owner"}},
                ))
        self.assertEqual(raised.exception.status_code, 409)

    def test_late_payment_for_canceled_order_requires_manual_review(self):
        source = inspect.getsource(main.apply_provider_status)
        self.assertIn("paid_after_order_cancelled", source)
        self.assertIn('order.get("status") == "rejected"', source)


if __name__ == "__main__":
    unittest.main()
