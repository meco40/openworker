import re

EMAIL_PATTERN = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
TOKEN_PATTERN = re.compile(
    r"\b(?:sk|pk|tok|token)[_-][A-Za-z0-9_-]{6,}\b",
    flags=re.IGNORECASE,
)


def redact_text(text: str) -> str:
    redacted = EMAIL_PATTERN.sub("[REDACTED_EMAIL]", text)
    redacted = TOKEN_PATTERN.sub("[REDACTED_TOKEN]", redacted)
    return redacted
