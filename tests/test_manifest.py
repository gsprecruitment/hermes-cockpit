"""The dashboard manifest's ``name`` IS the plugin's API namespace.

The gateway mounts ``dashboard/plugin_api.py`` under ``/api/plugins/<manifest
name>/`` (``_discover_dashboard_plugins`` reads the manifest's ``name``, falling
back to the folder name), and it gates that mount on ``plugins.enabled`` matching
the SAME string. The desktop half calls ``ctx.rest('/fleet')`` →
``/api/plugins/hermes-cockpit/fleet``.

When the manifest put the human label (``"Hermes Cockpit"``) in ``name`` and the
slug in an unread ``id`` field, two things broke at once:

* the router mounted under ``/api/plugins/Hermes Cockpit`` (never called), and
* ``"Hermes Cockpit"`` was not in ``plugins.enabled`` (``hermes-cockpit`` was),
  so the runtime gate refused the mount as a not-enabled plugin.

The desktop half then 404s, silently drops to its low-data RPC door, and never
shows the live fleet. These tests pin the contract so it cannot regress.
"""

from __future__ import annotations

import importlib
import json
import re
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
SLUG = "hermes-cockpit"


def _manifest() -> dict:
    return json.loads((ROOT / "dashboard" / "manifest.json").read_text(encoding="utf-8"))


def test_manifest_name_is_the_plugin_slug_not_the_label():
    m = _manifest()
    assert m["name"] == SLUG, "manifest name is the API namespace and must be the slug"
    assert re.fullmatch(r"[a-z0-9_-]{1,64}", m["name"]), "namespace must be a valid plugin slug"
    assert m.get("label"), "the human label belongs in `label`, not `name`"
    assert m.get("api") == "plugin_api.py"


def test_namespace_agrees_across_the_three_halves():
    """folder == manifest name == desktop id == agent plugin.yaml name."""
    assert (ROOT / "dashboard").parent.name == SLUG
    desktop = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    assert f"const ID = '{SLUG}'" in desktop
    assert re.search(rf"^name:\s*{re.escape(SLUG)}\s*$", (ROOT / "plugin.yaml").read_text(encoding="utf-8"), re.M)


def test_router_serves_the_desktop_namespace(tmp_path, monkeypatch):
    """Mounting under the manifest name serves GET /fleet at the desktop path."""
    home = tmp_path / "h"
    (home / "profiles" / "p1").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    sys.path.insert(0, str(ROOT / "dashboard"))
    sys.modules.pop("plugin_api", None)
    api = importlib.import_module("plugin_api")
    api._sensor = None
    app = FastAPI()
    app.include_router(api.router, prefix=f"/api/plugins/{_manifest()['name']}")
    c = TestClient(app)
    try:
        r = c.get(f"/api/plugins/{SLUG}/fleet")
        assert r.status_code == 200
        assert "units" in r.json()
    finally:
        api._sensor.stop()