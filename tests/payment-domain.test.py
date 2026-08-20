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
                {"id": "a34-id", "code": "a34", "name": "Последняя", "ordered": 1,
                 "paid": 300, "remain": 0, "total": 300, "tariff": "Тест"},
            ],
            "mentors": [
                {"id": "a21-mentor", "code": "a21", "name": "Флагман"},
                {"id": "a22-mentor", "code": "a22", "name": "Юрий"},
                {"id": "a34-mentor", "code": "a34", "name": "Последняя"},
            ],
            "clientPortals": [{
                "email": "client@example.com",
                "mentorIds": ["a21-mentor", "a22-mentor"],
            }],
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

    def test_multi_payment_applies_packages_and_creates_next_card_after_payment(self):
        state = self.base_state()
        order = {
            "id": 103,
            "client_email": "client@example.com",
            "order_type": "multi_order",
            "items": [
                {
                    "item_id": "103-1", "anketa_code": "a21", "anketa_name": "Флагман",
                    "is_new_anketa": False, "tariff_name": "Поддержка", "qty": 6,
                    "amount": 8290, "prepay_amount": 4145, "pay_full": False,
                },
                {
                    "item_id": "103-2", "anketa_code": "", "anketa_name": "Иван Иванов",
                    "is_new_anketa": True, "tariff_name": "Развитие", "qty": 12,
                    "amount": 15490, "prepay_amount": 15490, "pay_full": True,
                },
            ],
        }

        result = domain.apply_paid_order(
            state, order, "pay_multi", "2026-07-14T12:00:00+00:00"
        )

        self.assertEqual(result["affected_codes"], ["A-21", "a35"])
        self.assertEqual(result["created_anketas"][0]["code"], "a35")
        self.assertEqual(order["items"][1]["anketa_code"], "a35")
        self.assertEqual(state["clients"][0]["ordered"], 16)
        created = next(client for client in state["clients"] if client["code"] == "a35")
        self.assertEqual(
            (created["ordered"], created["paid"], created["remain"], created["total"]),
            (12, 15490, 0, 15490),
        )
        portal = state["clientPortals"][0]
        self.assertIn(result["created_anketas"][0]["mentorId"], portal["mentorIds"])
        self.assertEqual(state["income"][0]["amount"], 19635)

        snapshot = domain.refresh_financial_snapshot({
            "email": "client@example.com",
            "anketas": [{"code": "a21", "done": 0}],
        }, state)
        self.assertIn("a35", [item["code"] for item in snapshot["anketas"]])
        self.assertEqual(len(state["income"]), 1)
        self.assertTrue(domain.apply_paid_order(state, order, "pay_multi")["already_applied"])

    def test_referral_bonus_adds_one_review_without_changing_income(self):
        state = self.base_state()
        order = {
            "id": 104,
            "client_email": "client@example.com",
            "order_type": "multi_order",
            "_referral_bonus_qty": 1,
            "items": [{
                "item_id": "104-1", "anketa_code": "a21", "anketa_name": "Флагман",
                "is_new_anketa": False, "tariff_name": "Поддержка", "qty": 6,
                "amount": 8290, "prepay_amount": 4145, "pay_full": False,
            }],
        }

        result = domain.apply_paid_order(
            state, order, "pay_referral", "2026-08-20T12:00:00+00:00"
        )

        self.assertEqual(state["clients"][0]["ordered"], 17)
        self.assertEqual(state["income"][0]["amount"], 4145)
        self.assertEqual(result["referral_bonus"], {
            "anketa_code": "A-21", "anketa_name": "Флагман", "qty": 1,
        })
        self.assertEqual(result["package_items"][0]["qty"], 6)

    def test_webhook_signature_uses_raw_body_and_timestamp(self):
        raw = b'{"status":"paid","amount":"100.00"}'
        timestamp = "1784030400"
        secret = "test-signing-secret"
        signature = hmac.new(
            secret.encode(), timestamp.encode() + b"." + raw, hashlib.sha256
        ).hexdigest()
        self.assertTrue(domain.verify_webhook_signature(raw, timestamp, signature, secret))
        self.assertFalse(domain.verify_webhook_signature(raw + b" ", timestamp, signature, secret))

    def test_manual_transfer_discount_reprices_package_and_prepayment(self):
        items = [{"amount": 4800, "pay_full": False, "prepay_amount": 2400}]
        applied = domain.apply_flat_discount(items, 300)
        self.assertEqual(applied, 300)
        self.assertEqual(items[0], {
            "amount": 4500,
            "pay_full": False,
            "prepay_amount": 2250,
            "base_amount": 4800,
            "discount_amount": 300,
        })


if __name__ == "__main__":
    unittest.main()
