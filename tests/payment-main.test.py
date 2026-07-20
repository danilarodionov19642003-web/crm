import os
import unittest


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
        self.assertTrue(main.is_owner({"user_metadata": {"role": "owner"}}))
        self.assertFalse(main.is_owner({"user_metadata": {"role": "team"}}))


if __name__ == "__main__":
    unittest.main()
