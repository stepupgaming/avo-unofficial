"""Agent(P, K, f): inspect → propose → apply → evaluate → diagnose → commit/discard."""

from __future__ import annotations

from typing import Any

from editor_avo.edl import clone, load_edl
from editor_avo.evaluate import evaluate
from editor_avo.knowledge import load_knowledge
from editor_avo.lineage import Lineage
from editor_avo.mutations import MutationError, apply_mutation
from editor_avo.supervisor import Supervisor

EPS = 1e-9


def _parent_edl(lineage: Lineage, seed: dict) -> dict:
    best = lineage.best()
    if best and best.get("path"):
        return load_edl(best["path"])
    return clone(seed)


def _diagnostics(edl: dict, score: dict, k: dict) -> list[str]:
    d: list[str] = []
    vec = score.get("vector") or {}
    if vec.get("attention_support", 1) < 0.7:
        d.append("hook_needs_visual")
    if vec.get("semantic_alignment", 1) < 0.5:
        d.append("claim_unpaired")
    if vec.get("pacing", 1) < 0.6:
        d.append("flat_pacing")
    if vec.get("youtube_prior", 1) < 0.6:
        d.append("weak_packaging")
    if (score.get("counts") or {}).get("captions", 0) == 0:
        d.append("no_captions")
    _ = k
    _ = edl
    return d


def _propose(diags: list[str], tried: list[str], force: str | None, cheap: list[str]) -> str:
    if force and force not in tried:
        return force
    prefer = []
    if "hook_needs_visual" in diags:
        prefer += ["punch_in", "graphic", "caption"]
    if "claim_unpaired" in diags:
        prefer += ["caption_claim", "broll_swap"]
    if "flat_pacing" in diags:
        prefer += ["trim", "punch_in"]
    if "weak_packaging" in diags or "no_captions" in diags:
        prefer += ["caption", "graphic"]
    prefer += ["music_duck", "sfx", "speed"]
    for op in prefer + cheap:
        if op not in tried and op != "h3_regen":
            return op
    return "trim"


def vary_once(
    seed: dict,
    lineage: Lineage,
    k: dict | None = None,
    inner: int = 5,
) -> dict[str, Any]:
    k = k or load_knowledge()
    cheap = list(k.get("cheap_first") or [])
    supervisor = Supervisor()
    parent = _parent_edl(lineage, seed)
    parent_score = evaluate(parent, k)
    if not lineage.committed():
        lineage.commit(parent, parent_score, "seed")

    tried: list[str] = []
    force: str | None = None
    last: dict[str, Any] = {"status": "noop"}

    for _ in range(inner):
        best = lineage.best()
        best_scalar = best["scalar"] if best else parent_score["scalar"]
        diags = _diagnostics(parent, parent_score, k)
        redirect = supervisor.inspect(lineage.index["trajectory"], cheap)
        if redirect:
            force = redirect
        op = _propose(diags, tried, force, cheap)
        tried.append(op)
        try:
            cand = apply_mutation(parent, op)
        except MutationError as e:
            lineage.record_attempt(op, None, "error", str(e))
            last = {"status": "error", "op": op, "detail": str(e)}
            continue
        score = evaluate(cand, k)
        if not score["correctness"]:
            lineage.record_attempt(op, score, "discard", "correctness")
            last = {"status": "discard", "op": op, "score": score, "reason": "correctness"}
            continue
        if score["scalar"] + EPS < best_scalar:
            lineage.record_attempt(op, score, "discard", f"scalar {score['scalar']} < {best_scalar}")
            last = {"status": "discard", "op": op, "score": score, "reason": "no_improve"}
            continue
        rec = lineage.commit(cand, score, op)
        lineage.record_attempt(op, score, "commit", rec["id"])
        last = {"status": "commit", "op": op, "score": score, "id": rec["id"]}
        parent = cand
        parent_score = score
        break
    else:
        last.setdefault("supervisor_redirects", supervisor.redirects)
        last["status"] = last.get("status") or "stall"
    last["supervisor_redirects"] = supervisor.redirects
    last["tried"] = tried
    return last
