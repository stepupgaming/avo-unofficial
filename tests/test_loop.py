import json
from pathlib import Path

from editor_avo.edl import clone, correctness, load_edl
from editor_avo.evaluate import evaluate
from editor_avo.knowledge import load_knowledge
from editor_avo.lineage import Lineage
from editor_avo.mutations import H3_REFUSED, MutationError, apply_mutation
from editor_avo.vary import run_vary

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "fixtures" / "seed_edl.json"


def test_correctness_zeros():
    edl = load_edl(FIXTURE)
    edl["aspect"] = "16:9"
    s = evaluate(edl, load_knowledge())
    assert s["correctness"] is False
    assert s["scalar"] == 0
    assert all(v == 0 for v in s["vector"].values())


def test_h3_refused():
    edl = load_edl(FIXTURE)
    try:
        apply_mutation(edl, "h3_regen")
        raise AssertionError("should refuse")
    except MutationError as e:
        assert H3_REFUSED in str(e)


def test_overedit_not_rewarded():
    k = load_knowledge()
    base = load_edl(FIXTURE)
    base = apply_mutation(base, "trim", t1=32)
    good = apply_mutation(base, "caption")
    spam = clone(good)
    for i in range(12):
        spam = apply_mutation(spam, "caption", text=f"x{i}", t0=0.1 * i)
        spam = apply_mutation(spam, "sfx", t0=0.1 * i)
        spam = apply_mutation(spam, "punch_in", t0=0.2 * i)
    sg, ss = evaluate(good, k), evaluate(spam, k)
    assert ss["vector"]["overediting"] > 0
    assert ss["scalar"] <= sg["scalar"] + 0.15


def test_vary_step(tmp_path):
    lineage = tmp_path / "lineage"
    results = run_vary(FIXTURE, lineage, steps=1, inner=5)
    assert results
    idx = json.loads((lineage / "index.json").read_text())
    assert idx["committed"], "seed or better should be committed"
    assert results[0]["status"] in {"commit", "discard", "stall", "error"}
    # seed is weak; a cheap mutation should usually commit
    if results[0]["status"] == "commit":
        assert results[0]["score"]["correctness"] is True


def test_seed_correct():
    ok, reasons = correctness(load_edl(FIXTURE))
    assert ok, reasons
