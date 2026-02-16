import pytest

from app.tools.computer_use_tool import ComputerUseTool


def test_computer_use_requires_feature_flag() -> None:
    tool = ComputerUseTool(enabled=False)

    with pytest.raises(RuntimeError):
        tool.perform(action="click")


def test_computer_use_requires_approval_for_destructive_action() -> None:
    tool = ComputerUseTool(enabled=True)

    with pytest.raises(PermissionError):
        tool.perform(action="delete_file")


def test_computer_use_allows_destructive_action_when_approved() -> None:
    tool = ComputerUseTool(enabled=True)

    result = tool.perform(action="delete_file", approved=True)

    assert result["status"] == "ok"
    assert result["action"] == "delete_file"
