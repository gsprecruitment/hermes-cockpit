"""Standalone dev server: the real sensor + a browser harness for desktop/plugin.js.

    python dev/serve.py --bind 127.0.0.1 --port 8790 [--home ~/.hermes] [--config dev/cockpit.example.yaml]

Mounts the dashboard router exactly as the gateway would (``/api/plugins/hermes-cockpit``),
serves ``dev/harness.html`` which loads ``desktop/plugin.js`` with a browser-side mock of the
SDK (import map), so the page can be reviewed with real data before the plugin is installed in
the desktop app. Read-only against the Hermes home unless ``allow_task_create`` is set.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dashboard"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--home", default=None, help="HERMES_HOME to read (default: env or ~/.hermes)")
    ap.add_argument("--config", default=None, help="cockpit.yaml to use instead of $HERMES_HOME/cockpit.yaml")
    args = ap.parse_args()
    if args.home:
        os.environ["HERMES_HOME"] = str(Path(args.home).expanduser())

    import uvicorn
    from fastapi import FastAPI
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    import plugin_api
    from cockpit_sensor import Sensor
    from cockpit_sensor.config import hermes_home, load_config, parse_config

    if args.config:
        import yaml
        cfg = parse_config(yaml.safe_load(Path(args.config).read_text()) or {}, args.config)
        plugin_api._sensor = Sensor(home=hermes_home(), config=cfg)
        plugin_api._sensor.start()

    app = FastAPI(title="hermes-cockpit dev")
    # Mount under the namespace the desktop half actually calls — derived from the
    # manifest `name`, the same field the gateway's plugin discovery uses, so the
    # harness cannot silently test a namespace the real install never serves.
    import json

    manifest = json.loads((ROOT / "dashboard" / "manifest.json").read_text(encoding="utf-8"))
    prefix = f"/api/plugins/{manifest['name']}"
    app.include_router(plugin_api.router, prefix=prefix)
    app.mount("/desktop", StaticFiles(directory=str(ROOT / "desktop")), name="desktop")
    app.mount("/dev", StaticFiles(directory=str(ROOT / "dev")), name="dev")

    @app.get("/")
    def index():
        return FileResponse(str(ROOT / "dev" / "harness.html"))

    print(f"hermes-cockpit dev server → http://{args.bind}:{args.port}/   (home={hermes_home()})")
    uvicorn.run(app, host=args.bind, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
