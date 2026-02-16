import pytest

from app.subagents import SubagentManager


def test_subagent_spawn_list_and_update() -> None:
    manager = SubagentManager(max_depth=2, max_children=2)
    root = manager.spawn(parent_id=None)
    child = manager.spawn(parent_id=root.id)

    manager.update(child.id, status="completed")
    all_agents = manager.list_agents()

    assert len(all_agents) == 2
    assert {agent.id for agent in all_agents} == {root.id, child.id}
    assert manager.get(child.id).status == "completed"


def test_subagent_depth_limit_is_enforced() -> None:
    manager = SubagentManager(max_depth=1, max_children=2)
    root = manager.spawn(parent_id=None)
    child = manager.spawn(parent_id=root.id)

    with pytest.raises(ValueError):
        manager.spawn(parent_id=child.id)


def test_subagent_children_limit_is_enforced() -> None:
    manager = SubagentManager(max_depth=3, max_children=1)
    root = manager.spawn(parent_id=None)
    manager.spawn(parent_id=root.id)

    with pytest.raises(ValueError):
        manager.spawn(parent_id=root.id)
