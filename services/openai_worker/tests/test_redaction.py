from app.redaction import redact_text


def test_redaction_masks_email_and_token_patterns() -> None:
    text = "Contact alice@example.com using token sk_test_ABC1234567."

    redacted = redact_text(text)

    assert "alice@example.com" not in redacted
    assert "sk_test_ABC1234567" not in redacted
    assert "[REDACTED_EMAIL]" in redacted
    assert "[REDACTED_TOKEN]" in redacted
