"""EditorAVO: unofficial AVO operator over EDL timelines."""
__version__ = "0.0.1"

import sys
import json
from pathlib import Path

from editor_avo.lineage import Lineage
from editor_avo.knowledge import load_knowledge


def main():
    if len(sys.argv) < 2:
        print("Usage: editor_avo <command> [args]")
        print("Commands:")
        print("  vary <fixture> [--steps N]   Run variation operator")
        print("  lineage                       Show committed lineage")
        print("  knowledge                     Show editing knowledge/priors")
        sys.exit(1)

    command = sys.argv[1]

    if command == "vary":
        fixture = None
        steps = 1
        args = sys.argv[2:]
        i = 0
        while i < len(args):
            if args[i] == "--fixture" and i + 1 < len(args):
                fixture = args[i + 1]
                i += 2
            elif args[i] == "--steps" and i + 1 < len(args):
                steps = int(args[i + 1])
                i += 2
            else:
                i += 1
        if not fixture:
            print("Error: --fixture is required for vary command")
            sys.exit(1)
        from editor_avo.vary import run_vary
        lineage_dir = Path("/workspace/avo-unofficial/lineage")
        results = run_vary(fixture, lineage_dir, steps=steps)
        print(json.dumps({"results": results}, indent=2))

    elif command == "lineage":
        lineage = Lineage("/workspace/avo-unofficial/lineage")
        committed = lineage.committed()
        best = lineage.best()
        if not committed:
            print("No committed edits yet.")
        else:
            print(f"Committed: {len(committed)} edits")
            if best:
                print(f"Best scalar: {best['scalar']}")
            for c in committed:
                note = c.get("note", "")
                edl_id = c.get("edl_id", "")
                print(f"  {c['id']}: scalar={c.get('scalar', 'N/A')} edl_id={edl_id} note={note}")

    elif command == "knowledge":
        k = load_knowledge()
        print(f"Knowledge source: {k.get('source')}")
        print(f"Cheap first mutations: {k.get('cheap_first')}")
        print(f"Hook visual by s: {k.get('hook_visual_by_s')}")
        print(f"Broll reject if gt: {k.get('broll_reject_if_gt')}")

    else:
        print(f"Unknown command: {command}")
        print("Available commands: vary, lineage, knowledge")
        sys.exit(1)


if __name__ == "__main__":
    main()