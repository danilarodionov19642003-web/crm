import copy
import hashlib
import hmac
import importlib.util
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("payment_domain", ROOT / "payments/app/domain.py")
domain = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(domain)


class PaymentDomainTest(unittest.TestCase):
    def base_state(self):
        return {
            "clients": [
                {"id": "a21-id", "code": "A-21", "name": "Флагман", "ordered": 10,
                 "paid": 1000, "remain": 500, "total": 1500, "tariff": ""},
                {"id": "a22-id", "code": "a22", "name": "Юрий", "ordered": 12,
                 "paid": 7745, "remain": 7745, "total": 15490, "tariff": "Развитие"},
            ],
            "income": [],
        }

    def test_half_payment_updates_order_and_finances_once(self):
        state = self.base_state()
        order = {"id": 101, "order_type": "order", "anketa_code": "a21",
                 "tariff_name": "Поддержка", "qty": 6, "amount": 8290,
                 "prepay_amount": 4145, "pay_full": False}
        result = domain.apply_paid_order(state, order, "pay_test", "2026-07-14T12:00:00+00:00")
        client = state["clients"][0]
        self.assertEqual((client["ordered"], client["paid"], client["remain"], client["total"]),
                         (16, 5145, 4645, 9790))
        self.assertFalse(result["already_applied"])
        again = domain.apply_paid_order(state, order, "pay_test", "2026-07-14T12:00:00+00:00")
        self.assertTrue(again["already_applied"])
        self.assertEqual(len(state["income"]), 1)

    def test_remainder_can_cover_multiple_profiles(self):
        state = self.base_state()
        order = {"id": 102, "order_type": "remainder", "amount": 8245, "items": [
            {"code": "A21", "amount": 500, "source_order_id": 1},
            {"code": "A-22", "amount": 7745, "source_order_id": 2},
        ]}
        domain.apply_paid_order(state, order, "pay_rem", "2026-07-14T12:00:00+00:00")
        self.assertEqual((state["clients"][0]["paid"], state["clients"][0]["remain"]), (1500, 0))
        self.assertEqual((state["clients"][1]["paid"], state["clients"][1]["remain"]), (15490, 0))
        self.assertEqual(state["income"][0]["amount"], 8245)

    def test_snapshot_is_rebuilt_from_state(self):
        state = self.base_state()
        payload = {"anketas": [
            {"code": "a21", "ordered": 0, "done": 2, "paid": 0, "remain": 0, "total": 0},
            {"code": "a22", "ordered": 0, "done": 3, "paid": 0, "remain": 0, "total": 0},
        ], "totals": {}}
        result = domain.refresh_financial_snapshot(payload, state)
        self.assertEqual(result["totals"], {
            "ordered": 22, "done": 5, "paid": 8745, "remain": 8245, "total": 16990,
        })
        self.assertEqual(payload["totals"], {})

    def test_webhook_signature_uses_raw_body_and_timestamp(self):
        raw = b'{"status":"paid","amount":"100.00"}'
        timestamp = "1784030400"
        secret = "test-signing-secret"
        signature = hmac.new(
            secret.encode(), timestamp.encode() + b"." + raw, hashlib.sha256
        ).hexdigest()
        self.assertTrue(domain.verify_webhook_signature(raw, timestamp, signature, secret))
        self.assertFalse(domain.verify_webhook_signature(raw + b" ", timestamp, signature, secret))


if __name__ == "__main__":
    unittest.main()
