import hmac


def validate_callback_token(
    provided_token: str | None,
    expected_token: str | None,
) -> bool:
    if not provided_token or not expected_token:
        return False
    return hmac.compare_digest(provided_token, expected_token)
