"""Vary(P) = Agent(P, K, f) entry."""

from __future__ import annotations

from pathlib import Path

from editor_avo.agent import vary_once
from editor_avo.edl import load_edl
from editor_avo.knowledge import load_knowledge
from editor_avo.lineage import Lineage


def run_vary(
    fixture: str | Path,
    lineage_dir: str | Path,
    steps: int = 1,
    inner: int = 5,
) -> list[dict]:
    seed = load_edl(fixture)
    lineage = Lineage(lineage_dir)
    k = load_knowledge()
    results = []
    for _ in range(steps):
        results.append(vary_once(seed, lineage, k=k, inner=inner))
    return results
