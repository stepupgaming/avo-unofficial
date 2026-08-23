"""P: committed (x, f(x)) lineage. Internal trajectory is separate."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from editor_avo.edl import save_edl


class Lineage:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "commits").mkdir(exist_ok=True)
        self.index_path = self.root / "index.json"
        if self.index_path.exists():
            self.index = json.loads(self.index_path.read_text())
        else:
            self.index = {"committed": [], "trajectory": []}

    def save(self) -> None:
        self.index_path.write_text(json.dumps(self.index, indent=2) + "\n")

    def committed(self) -> list[dict[str, Any]]:
        return self.index["committed"]

    def best(self) -> dict[str, Any] | None:
        if not self.index["committed"]:
            return None
        return max(self.index["committed"], key=lambda r: r.get("scalar", 0))

    def commit(self, edl: dict, score: dict, note: str) -> dict:
        n = len(self.index["committed"]) + 1
        rec = {
            "id": f"x{n}",
            "t": time.time(),
            "scalar": score["scalar"],
            "vector": score["vector"],
            "correctness": score["correctness"],
            "note": note,
            "edl_id": edl.get("id"),
        }
        path = self.root / "commits" / f"{rec['id']}.json"
        save_edl(edl, path)
        rec["path"] = str(path)
        self.index["committed"].append(rec)
        self.save()
        return rec

    def record_attempt(self, op: str, score: dict | None, status: str, detail: str) -> None:
        self.index["trajectory"].append(
            {
                "t": time.time(),
                "op": op,
                "status": status,
                "scalar": None if score is None else score.get("scalar"),
                "detail": detail,
            }
        )
        self.save()
