#!/usr/bin/env python3
"""Read and export bundled DESIGN.md snapshots. Python 3.9+, standard library only."""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def catalog():
    data = json.loads((ROOT / "catalog.json").read_text(encoding="utf-8"))
    if data.get("schemaVersion") != 1 or not isinstance(data.get("designs"), list):
        raise ValueError("Invalid design catalog")
    return data["designs"]


def resolve_design(identifier):
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,63}", identifier) or ".." in identifier:
        raise ValueError("Invalid design identifier")
    item = next((entry for entry in catalog() if entry["id"] == identifier), None)
    if item is None:
        raise ValueError(f"Unknown design: {identifier}. Use list to see available designs.")
    library = (ROOT / "library").resolve()
    source = (library / identifier / "DESIGN.md").resolve()
    if library not in source.parents or not source.is_file():
        raise ValueError("Design source is missing or outside the bundled library")
    return item, source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list", help="List designs or search metadata and full text")
    listing.add_argument("--query", default="")
    showing = commands.add_parser("show", help="Print one original DESIGN.md")
    showing.add_argument("id")
    exporting = commands.add_parser("export", help="Create DESIGN.md at an explicit new destination")
    exporting.add_argument("id")
    exporting.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        if args.command == "list":
            terms = args.query.casefold().split()
            matches = []
            for item in catalog():
                index_text = json.dumps(item, ensure_ascii=False).casefold()
                if terms and not all(term in index_text for term in terms):
                    _, source = resolve_design(item["id"])
                    index_text += "\n" + source.read_text(encoding="utf-8").casefold()
                if all(term in index_text for term in terms):
                    matches.append(item)
            print(json.dumps({"count": len(matches), "designs": matches}, ensure_ascii=False, indent=2))
            return 0
        item, source = resolve_design(args.id)
        if args.command == "show":
            sys.stdout.write(source.read_text(encoding="utf-8"))
            return 0
        output = Path(args.output).expanduser().absolute()
        if not output.parent.is_dir():
            raise ValueError("Output directory does not exist; choose an existing project directory")
        # Exclusive create prevents accidental replacement, including a dangling symlink.
        with output.open("xb") as stream:
            stream.write(source.read_bytes())
        print(json.dumps({"id": item["id"], "output": str(output)}, ensure_ascii=False))
        return 0
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
