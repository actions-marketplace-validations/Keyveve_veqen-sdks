"""check_spend never lets an agent spend unchecked: no key, or no answer from Veqen, gives ``on_error``."""

from veqen import check_spend, init, record_action


def test_check_spend_fails_closed_without_an_answer():
    assert check_spend("bot", 5).decision == "deny" and record_action("bot", 5) is False
    init(api_key="vq_live_test", endpoint="http://127.0.0.1:9")  # nothing listens there
    denied = check_spend("bot", 5, payee="Acme")
    assert not denied.allowed and "couldn't be reached" in denied.reasons[0] and len(denied.action_id) == 32
    assert check_spend("bot", 5, on_error="allow").allowed
