from __future__ import annotations

import importlib.util
import unittest
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo


MODULE_PATH = Path(__file__).with_name("mentori_finance_telegram.py")
SPEC = importlib.util.spec_from_file_location("mentori_finance_telegram", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FinanceTelegramTest(unittest.TestCase):
    def test_balance_matches_crm_created_at_boundary(self) -> None:
        state = {
            "finance": {
                "balance": 6076,
                "balanceUpdatedAt": "2026-07-30T18:16:28.972Z",
            },
            "income": [
                {"amount": 1000, "createdAt": "2026-07-30T18:16:29.000Z"},
                {"amount": 5000, "createdAt": "2026-07-30T18:16:00.000Z"},
            ],
            "expenses": [
                {"amount": 99, "createdAt": "2026-07-30T20:00:00.000Z"},
                {"amount": 900, "createdAt": "2026-07-29T12:00:00.000Z"},
            ],
        }
        result = MODULE.compute_current_balance(state)
        self.assertEqual(result["current"], Decimal("6977"))
        self.assertEqual(result["income_after"], Decimal("1000"))
        self.assertEqual(result["expense_after"], Decimal("99"))

    def test_balance_falls_back_to_record_date(self) -> None:
        state = {
            "finance": {"balance": 100, "balanceUpdatedAt": "2026-07-30T10:00:00Z"},
            "income": [{"amount": 50, "date": "2026-07-31"}],
            "expenses": [{"amount": 10, "date": "2026-07-30"}],
        }
        self.assertEqual(MODULE.compute_current_balance(state)["current"], Decimal("150"))

    def test_balance_message_includes_today_totals(self) -> None:
        state = {
            "finance": {"balance": 200, "balanceUpdatedAt": "2026-07-30T00:00:00Z"},
            "income": [{"amount": 300, "date": "2026-07-31", "createdAt": "2026-07-31T10:00:00Z"}],
            "expenses": [{"amount": 99, "date": "2026-07-31", "createdAt": "2026-07-31T11:00:00Z"}],
        }
        text = MODULE.balance_text(
            state,
            now=datetime(2026, 7, 31, 23, 0, tzinfo=ZoneInfo("Europe/Moscow")),
        )
        self.assertIn("401 ₽", text)
        self.assertIn("300 ₽", text)
        self.assertIn("99 ₽", text)

    def test_finance_messages_escape_user_text(self) -> None:
        text = MODULE.expense_text({
            "id": "x<1",
            "amount": 99,
            "date": "2026-07-31",
            "category": "<Номер>",
            "comment": "A&B",
            "source": "crm",
        })
        self.assertIn("&lt;Номер&gt;", text)
        self.assertIn("A&amp;B", text)
        self.assertNotIn("<Номер>", text)


if __name__ == "__main__":
    unittest.main()
