"""Make tests/entitlement-vectors.json from the member bot's own entitlement rule.

The web app works out membership in TypeScript (supabase/functions/_shared/
entitlement.ts). These vectors are what keeps it in step with the member bot:
each case is a Stripe subscription, and each check asks the bot's is_entitled()
whether that account is entitled at a given moment. The Deno tests assert the
web rule gives the same answers.

Run it with the member bot's Python, after any change to its rule:

    ~/ping-member-bot/.venv/bin/python tools/make_vectors.py ~/ping-member-bot > tests/entitlement-vectors.json

Checks are only made while the subscription would still look like this in
Stripe. The bot re-reads Stripe every 5 minutes, so "active" means entitled for
as long as it stays active. The web app checks less often, so it stores a time
(see entitlement.ts), and the two only have to agree before the next billing
event: before the period or trial ends, or a scheduled cancellation happens.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

GRACE = timedelta(hours=72)
T0 = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)
H = timedelta(hours=1)
D = timedelta(days=1)
S = timedelta(seconds=1)


def iso(t: datetime | None) -> str | None:
    return t.isoformat().replace("+00:00", "Z") if t else None


CASES = [
    # name, status, period_start, period_end, trial_end, cancel_at, cancel_at_period_end, past_due_since, check times
    ("trial running", "trialing", T0, T0 + 14 * D, T0 + 14 * D, None, False, None,
     [T0, T0 + 13 * D, T0 + 14 * D - S]),
    ("trial running, cancelled at the trial end", "trialing", T0, T0 + 14 * D, T0 + 14 * D, None, True, None,
     [T0 + D, T0 + 14 * D - S]),
    ("trial running, cancel_at before the trial end", "trialing", T0, T0 + 14 * D, T0 + 14 * D, T0 + 5 * D, False,
     None, [T0 + D, T0 + 5 * D - S]),
    ("trial with no trial_end, only a period end", "trialing", T0, T0 + 14 * D, None, None, False, None,
     [T0 + D]),
    ("paying", "active", T0, T0 + 30 * D, None, None, False, None,
     [T0, T0 + 29 * D, T0 + 30 * D - S]),
    ("paying, cancelled at period end", "active", T0, T0 + 30 * D, None, None, True, None,
     [T0 + D, T0 + 30 * D - S]),
    ("paying, cancel_at mid-period (flexible billing)", "active", T0, T0 + 30 * D, None, T0 + 10 * D, False, None,
     [T0 + D, T0 + 10 * D - S]),
    ("paying after a trial", "active", T0, T0 + 30 * D, T0 - S, None, False, None,
     [T0 + D]),
    ("past due, grace from the unpaid period's start", "past_due", T0, T0 + 30 * D, None, None, False, None,
     [T0, T0 + H, T0 + 72 * H - S, T0 + 72 * H, T0 + 5 * D, T0 + 40 * D]),
    ("past due since an earlier period (Stripe left it past_due)", "past_due", T0, T0 + 30 * D, None, None, False,
     T0 - 30 * D, [T0 - 30 * D + H, T0, T0 + H]),
    ("past due, first unpaid period started just now", "past_due", T0, T0 + 30 * D, None, None, False, T0,
     [T0 + 71 * H, T0 + 72 * H]),
    ("past due with no period start (old data): grace from period end", "past_due", None, T0, None, None, False,
     None, [T0 - D, T0 + 71 * H, T0 + 72 * H]),
    ("past due after a failed first charge", "past_due", T0, T0 + 30 * D, T0, None, False, None,
     [T0 + H, T0 + 73 * H]),
    ("cancelled during the trial", "canceled", T0 - 2 * D, T0 + 12 * D, T0 + 12 * D, None, False, None,
     [T0, T0 + 12 * D - S, T0 + 12 * D, T0 + 20 * D]),
    ("cancelled after the trial", "canceled", T0 - 40 * D, T0 - 10 * D, T0 - 26 * D, None, False, None,
     [T0, T0 + D]),
    ("cancelled, never had a trial", "canceled", T0 - 30 * D, T0, None, None, False, None,
     [T0 - D, T0, T0 + D]),
    ("unpaid", "unpaid", T0, T0 + 30 * D, None, None, False, None, [T0, T0 + D]),
    ("incomplete", "incomplete", T0, T0 + 30 * D, None, None, False, None, [T0]),
    ("incomplete_expired", "incomplete_expired", T0, T0 + 30 * D, None, None, False, None, [T0]),
    ("paused (trial ended with no card)", "paused", T0, T0 + 30 * D, T0, None, False, None, [T0, T0 + H]),
]


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.path.insert(0, str(Path(sys.argv[1]).expanduser().resolve()))
    from first_in_bot.entitlement import is_entitled
    from first_in_bot.models import User

    cases = []
    for name, status, start, end, trial_end, cancel_at, cancel_pe, past_due_since, times in CASES:
        user = User(
            telegram_id=1,
            stripe_sub_id="sub_vector",
            sub_status=status,
            sub_period_start=start,
            sub_period_end=end,
            sub_trial_end=trial_end,
            cancel_at_period_end=cancel_pe or cancel_at is not None,
            # The bot only keeps this while past_due (billing.write_subscription).
            past_due_since=past_due_since if status == "past_due" else None,
        )
        cases.append({
            "name": name,
            "subscription": {
                "status": status,
                "period_start": iso(start),
                "period_end": iso(end),
                "trial_end": iso(trial_end),
                "cancel_at": iso(cancel_at),
                "cancel_at_period_end": cancel_pe,
                "past_due_since": iso(past_due_since),
            },
            "checks": [{"at": iso(t), "member": is_entitled(user, t, GRACE)} for t in times],
        })
    json.dump({
        "about": "Made by tools/make_vectors.py from ping-member-bot's first_in_bot.entitlement.is_entitled. "
                 "Don't edit by hand.",
        "grace_hours": GRACE // H,
        "cases": cases,
    }, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
