"""CLI: python -m editor_avo vary --fixture ... --steps 1"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from editor_avo.evaluate import evaluate
from editor_avo.knowledge import load_knowledge
from editor_avo.mutations import H3_REFUSED, apply_mutation
from editor_avo.vary import run_vary


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="editor-avo")
    sub = p.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("vary", help="one or more Agent variation steps")
    v.add_argument("--fixture", default="fixtures/seed_edl.json")
    v.add_argument("--lineage", default="lineage")
    v.add_argument("--steps", type=int, default=1)
    v.add_argument("--inner", type=int, default=5)
    s = sub.add_parser("score", help="score an EDL")
    s.add_argument("edl")
    h = sub.add_parser("h3-probe", help="show H3 stub refuse")
    _ = h
    args = p.parse_args(argv)
    if args.cmd == "vary":
        results = run_vary(args.fixture, args.lineage, steps=args.steps, inner=args.inner)
        print(json.dumps(results, indent=2, default=str))
        return 0
    if args.cmd == "score":
        from editor_avo.edl import load_edl

        print(json.dumps(evaluate(load_edl(args.edl), load_knowledge()), indent=2))
        return 0
    if args.cmd == "h3-probe":
        from editor_avo.edl import load_edl

        try:
            apply_mutation(load_edl("fixtures/seed_edl.json"), "h3_regen")
        except Exception as e:
            print(H3_REFUSED if H3_REFUSED in str(e) else str(e))
            return 0
        print("unexpected success")
        return 2
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
