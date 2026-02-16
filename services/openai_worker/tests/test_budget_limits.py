import pytest

from app.budget import BudgetLimitExceeded, BudgetManager


def test_budget_enforces_per_run_limit() -> None:
    budget = BudgetManager(max_per_run=10.0, max_per_user=100.0)
    budget.charge(run_id="run-1", user_id="user-1", amount=7.0)

    with pytest.raises(BudgetLimitExceeded):
        budget.charge(run_id="run-1", user_id="user-1", amount=4.0)


def test_budget_enforces_per_user_limit_across_runs() -> None:
    budget = BudgetManager(max_per_run=100.0, max_per_user=10.0)
    budget.charge(run_id="run-1", user_id="user-1", amount=6.0)

    with pytest.raises(BudgetLimitExceeded):
        budget.charge(run_id="run-2", user_id="user-1", amount=5.0)
