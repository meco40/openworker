from dataclasses import dataclass, field
import uuid


@dataclass
class Subagent:
    id: str
    parent_id: str | None
    depth: int
    status: str = "running"
    children: list[str] = field(default_factory=list)


class SubagentManager:
    def __init__(self, max_depth: int = 2, max_children: int = 3) -> None:
        if max_depth < 0:
            raise ValueError("max_depth must be >= 0")
        if max_children < 1:
            raise ValueError("max_children must be >= 1")
        self._max_depth = max_depth
        self._max_children = max_children
        self._agents: dict[str, Subagent] = {}

    def spawn(self, parent_id: str | None) -> Subagent:
        depth = 0
        if parent_id is not None:
            parent = self._agents.get(parent_id)
            if parent is None:
                raise KeyError(parent_id)
            if len(parent.children) >= self._max_children:
                raise ValueError("max children exceeded")
            depth = parent.depth + 1
            if depth > self._max_depth:
                raise ValueError("max depth exceeded")

        agent_id = f"sub-{uuid.uuid4().hex[:10]}"
        agent = Subagent(id=agent_id, parent_id=parent_id, depth=depth)
        self._agents[agent_id] = agent
        if parent_id is not None:
            self._agents[parent_id].children.append(agent_id)
        return agent

    def get(self, agent_id: str) -> Subagent:
        agent = self._agents.get(agent_id)
        if agent is None:
            raise KeyError(agent_id)
        return agent

    def list_agents(self) -> tuple[Subagent, ...]:
        return tuple(self._agents.values())

    def update(self, agent_id: str, status: str) -> Subagent:
        if not status.strip():
            raise ValueError("status is required")
        agent = self.get(agent_id)
        agent.status = status
        return agent
