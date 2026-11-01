#!/usr/bin/env python3
"""Install the same native plugin without requiring a system Node.js runtime."""
import argparse
import json
import os
import shutil
from pathlib import Path


def install(target):
    source = Path(__file__).resolve().parent.parent
    target = Path(target).expanduser().resolve()
    target.mkdir(parents=True, exist_ok=True)
    (target / "plugins").mkdir(exist_ok=True)
    manifest_path = target / "package.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"private": True}
    manifest.setdefault("dependencies", {})["@opencode-ai/sdk"] = "1.19.5"
    if source != target:
        shutil.copytree(source / "telegram", target / "telegram", dirs_exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    plugin = target / "plugins" / "telegram.js"
    plugin.write_text("export { default } from '../telegram/plugin.mjs';\n")
    print(f"Telegram plugin installed: {plugin}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    default = os.environ.get("OPENCODE_CONFIG_DIR") or str(
        Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "opencode")
    parser.add_argument("--config-dir", default=default)
    install(parser.parse_args().config_dir)
