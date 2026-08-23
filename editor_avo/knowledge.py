"""K: load editing-genome priors when present."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

DEFAULT_GENOME = Path("/workspace/editing-genome")


def load_knowledge(genome_dir: str | Path | None = None) -> dict[str, Any]:
    root = Path(genome_dir or DEFAULT_GENOME)
    k: dict[str, Any] = {
        "source": str(root) if root.exists() else None,
        "cheap_first": [
            "trim",
            "reorder",
            "punch_in",
            "speed",
            "caption",
            "graphic",
            "broll_swap",
            "sfx",
            "music_duck",
        ],
        "expensive_last": ["h3_regen"],
        "hook_visual_by_s": 1.0,
        "claim_visual_age_s": 2.0,
        "overedit_bands": {"captions": 6, "sfx": 4, "punch_ins": 3},
        "broll_reject_if_gt": 4.0,
        "do_not_reward_more_ornament": True,
    }
    priors = root / "genome" / "v0_priors.json"
    if priors.exists():
        k["priors"] = json.loads(priors.read_text())
        hyp = k["priors"].get("hypothesized") or {}
        hook = hyp.get("hook") or {}
        if hook.get("must_change_visual_or_type_by_s") is not None:
            k["hook_visual_by_s"] = float(hook["must_change_visual_or_type_by_s"])
        broll = hyp.get("broll_duration_s") or {}
        if broll.get("reject_if_gt") is not None:
            k["broll_reject_if_gt"] = float(broll["reject_if_gt"])
    paper_map = root / "paper-map.md"
    if paper_map.exists():
        k["paper_map_head"] = paper_map.read_text()[:2000]
    return k
