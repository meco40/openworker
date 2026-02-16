from collections import defaultdict


class BudgetLimitExceeded(RuntimeError):
    pass


class BudgetManager:
    def __init__(self, *, max_per_run: float, max_per_user: float) -> None:
        if max_per_run <= 0 or max_per_user <= 0:
            raise ValueError("budget limits must be positive")
        self._max_per_run = max_per_run
        self._max_per_user = max_per_user
        self._run_totals: dict[str, float] = defaultdict(float)
        self._user_totals: dict[str, float] = defaultdict(float)

    def charge(self, *, run_id: str, user_id: str, amount: float) -> None:
        if amount < 0:
            raise ValueError("amount must be non-negative")

        run_total = self._run_totals[run_id] + amount
        user_total = self._user_totals[user_id] + amount

        if run_total > self._max_per_run:
            raise BudgetLimitExceeded(f"run budget exceeded for {run_id}")
        if user_total > self._max_per_user:
            raise BudgetLimitExceeded(f"user budget exceeded for {user_id}")

        self._run_totals[run_id] = run_total
        self._user_totals[user_id] = user_total
