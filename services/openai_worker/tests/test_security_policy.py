from app.security import validate_callback_token


def test_validate_callback_token_accepts_match() -> None:
    assert validate_callback_token("secret-token", "secret-token") is True


def test_validate_callback_token_rejects_mismatch() -> None:
    assert validate_callback_token("secret-token", "wrong-token") is False
