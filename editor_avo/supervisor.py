"""Self-supervision: redirect when the agent stalls or cycles."""

from __future__ import annotations

from collections import Counter
from typing import Any


class Supervisor:
    def __init__(self, stall_after: int = 3) -> None:
        self.stall_after = stall_after
        self.redirects = 0

    def inspect(self, trajectory: list[dict[str, Any]], cheap: list[str]) -> str | None:
        recent = trajectory[-8:]
        if not recent:
            return None
        ops = [r.get("op") for r in recent]
        if len(ops) >= self.stall_after and len(set(ops[-self.stall_after :])) == 1:
            self.redirects += 1
            current = ops[-1]
            for alt in cheap:
                if alt != current:
                    return alt
        statuses = [r.get("status") for r in recent]
        if statuses.count("discard") >= self.stall_after and "commit" not in statuses[-self.stall_after :]:
            self.redirects += 1
            used = Counter(ops)
            for alt in cheap:
                if used.get(alt, 0) == 0:
                    return alt
            return "trim"
        return None
