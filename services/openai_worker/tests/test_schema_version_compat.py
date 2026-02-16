from app.models import (
    CURRENT_SCHEMA_VERSION,
    PREVIOUS_SCHEMA_VERSION,
    is_compatible_schema_version,
)


def test_schema_compat_accepts_current_and_previous() -> None:
    assert is_compatible_schema_version(CURRENT_SCHEMA_VERSION) is True
    assert is_compatible_schema_version(PREVIOUS_SCHEMA_VERSION) is True


def test_schema_compat_rejects_outside_supported_range() -> None:
    assert is_compatible_schema_version(CURRENT_SCHEMA_VERSION + 1) is False
    assert is_compatible_schema_version(PREVIOUS_SCHEMA_VERSION - 1) is False
