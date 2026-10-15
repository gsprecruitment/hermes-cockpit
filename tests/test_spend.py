"""Spend aggregation against small sqlite fixtures built here."""

from __future__ import annotations

import os
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dashboard"))

from cockpit_sensor import spend  # noqa: E402
from cockpit_sensor.config import parse_config  # noqa: E402
from cockpit_sensor import Sensor  # noqa: E402


@pytest.fixture(autouse=True)
def utc(monkeypatch):
    monkeypatch.setenv("TZ", "UTC")
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


# Wednesday 2026-10-14 12:00 UTC
NOW = datetime(2026, 10, 14, 12, 0).timestamp()
H = 3600


def _db(path: Path, sessions=(), usage=()):
    path.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(path)
    c.executescript("""
    create table sessions(id text primary key, source text, model text, billing_provider text, billing_mode text, started_at real,
        ended_at real, end_reason text, message_count int, tool_call_count int, api_call_count int, input_tokens int, output_tokens int,
        cache_read_tokens int, cache_write_tokens int, reasoning_tokens int, estimated_cost_usd real, actual_cost_usd real,
        cost_status text, cost_source text, title text, parent_session_id text);
    create table session_model_usage(session_id text, model text, billing_provider text, billing_mode text, task text, api_call_count int,
        input_tokens int, output_tokens int, cache_read_tokens int, cache_write_tokens int, reasoning_tokens int, estimated_cost_usd real,
        actual_cost_usd real, cost_status text, cost_source text, first_seen real, last_seen real);
    """)
    for s in sessions:
        d = dict(source="cli", model="m1", billing_provider="nous", billing_mode=None, ended_at=None, end_reason="cli_close", message_count=10,
                 tool_call_count=2, api_call_count=3, input_tokens=1000, output_tokens=200, cache_read_tokens=0, cache_write_tokens=0,
                 reasoning_tokens=0, estimated_cost_usd=1.0, actual_cost_usd=None, cost_status="estimated", cost_source="x", title="t",
                 parent_session_id=None)
        d.update(s)
        c.execute(f"insert into sessions({','.join(d)}) values({','.join('?' * len(d))})", tuple(d.values()))
    for u in usage:
        d = dict(model="m1", billing_provider="nous", billing_mode=None, task="", api_call_count=1, input_tokens=10, output_tokens=5,
                 cache_read_tokens=0, cache_write_tokens=0, reasoning_tokens=0, estimated_cost_usd=0.5, actual_cost_usd=0.0,
                 cost_status="estimated", cost_source="x", first_seen=NOW - H, last_seen=NOW - H)
        d.update(u)
        c.execute(f"insert into session_model_usage({','.join(d)}) values({','.join('?' * len(d))})", tuple(d.values()))
    c.commit()
    c.close()


@pytest.fixture
def home(tmp_path: Path) -> Path:
    h = tmp_path / "hermes"
    today = NOW - 2 * H
    yesterday = NOW - DAY_ + 0
    last_month = datetime(2026, 9, 20, 10).timestamp()
    _db(h / "state.db", sessions=[
        dict(id="d1", started_at=today, estimated_cost_usd=2.0, cache_read_tokens=3000),
        dict(id="d2", started_at=today, estimated_cost_usd=0.5, output_tokens=0, source="cron"),             # zero output
    ])
    _db(h / "profiles/chief/state.db", sessions=[
        dict(id="c1", started_at=yesterday, estimated_cost_usd=1.5, billing_provider="alibaba-token-plan", cost_status="unknown",
             model="qwen"),
        dict(id="c2", started_at=today, estimated_cost_usd=0.25, message_count=1, end_reason="agent_close"),  # single message
        dict(id="c3", started_at=today, estimated_cost_usd=0.75, end_reason="provider_error", actual_cost_usd=0.7),
        dict(id="old", started_at=last_month, estimated_cost_usd=9.0),
    ], usage=[dict(session_id="c1", model="qwen", billing_provider="alibaba-token-plan", estimated_cost_usd=1.5, first_seen=yesterday),
              dict(session_id="c3", model="m1", estimated_cost_usd=0.75, first_seen=today)])
    (h / "profiles/chief/config.yaml").write_text("model: x\n")
    (h / "profiles/ghost").mkdir()  # profile without a state.db is tolerated
    (h / "profiles/ghost/config.yaml").write_text("model: y\n")
    return h


DAY_ = 86400


def cfg(ceiling=None):
    return parse_config({"spend_ceiling_usd": ceiling, "groups": [{"id": "lead", "label": "Leadership", "profiles": ["chief"]}]})


def test_windows_week_starts_monday():
    w = spend.windows(NOW)
    assert datetime.fromtimestamp(w["week"]["start"]).strftime("%a %Y-%m-%d") == "Mon 2026-10-12"
    assert datetime.fromtimestamp(w["month"]["start"]).day == 1
    assert (w["today"]["start"] - w["30d"]["start"]) == 29 * DAY_


def test_totals_and_breakdowns(home):
    r = spend.compute(home, cfg(), "month", now=NOW)
    assert r["totals"]["today"]["cost"] == pytest.approx(2.0 + 0.5 + 0.25 + 0.75)
    assert r["totals"]["week"]["cost"] == pytest.approx(5.0)              # Mon 12th onward: yesterday (Tue) included
    assert r["totals"]["month"]["cost"] == pytest.approx(5.0)             # the 20 Sep session is outside October
    assert r["totals"]["30d"]["cost"] == pytest.approx(14.0)
    assert r["totals"]["today"]["sessions"] == 4 and r["totals"]["week"]["sessions"] == 5
    assert r["totals"]["month"]["cost_actual"] == pytest.approx(0.7) and r["totals"]["month"]["actual_sessions"] == 1
    assert r["totals"]["today"]["tokens_cache_read"] == 3000
    prof = {p["profile"]: p for p in r["by_profile"]}
    assert prof["default"]["cost"] == pytest.approx(2.5) and prof["chief"]["department"] == "Leadership"
    dept = {d["label"]: d["cost"] for d in r["by_department"]}
    assert dept == {"Leadership": pytest.approx(2.5), "Other": pytest.approx(2.5)}
    assert {s["key"] for s in r["by_source"]} == {"cli", "cron"}
    prov = {p["key"]: p for p in r["by_provider"]}
    assert prov["alibaba-token-plan"]["kind"] == "subscription" and prov["alibaba-token-plan"]["label"] == "Alibaba Token Plan"
    assert prov["nous"]["kind"] == "metered"
    assert r["model_source"] == "session_model_usage"
    assert {m["model"] for m in r["by_model"]} == {"qwen", "m1"}


def test_day_series_filled_and_split_by_provider(home):
    r = spend.compute(home, cfg(), "week", now=NOW)
    assert [d["date"] for d in r["by_day"]] == ["2026-10-12", "2026-10-13", "2026-10-14"]
    assert r["by_day"][0]["cost"] == 0.0
    assert r["by_day"][1]["by_provider"] == {"Alibaba Token Plan": 1.5}
    assert sum(d["cost"] for d in r["by_day"]) == pytest.approx(r["selected"]["cost"])


def test_waste_categories(home):
    r = spend.compute(home, cfg(), "month", now=NOW)
    cats = {c["id"]: c for c in r["waste"]["categories"]}
    assert cats["zero_output"]["count"] == 1 and cats["zero_output"]["examples"][0]["id"] == "d2"
    assert cats["single_message"]["count"] == 1 and cats["single_message"]["examples"][0]["profile"] == "chief"
    assert cats["error_end"]["count"] == 1 and cats["error_end"]["examples"][0]["id"] == "c3"
    assert cats["unpriced"]["count"] == 1 and cats["unpriced"]["counts_as_waste"] is False
    assert r["waste"]["sessions"] == 3 and r["waste"]["cost"] == pytest.approx(0.5 + 0.25 + 0.75)
    assert r["waste"]["cost_pct"] == pytest.approx(1.5 / 5.0, abs=1e-3)
    prof = {p["profile"]: p for p in r["by_profile"]}
    assert prof["chief"]["waste_cost"] == pytest.approx(1.0) and prof["chief"]["waste_sessions"] == 2


def test_examples_capped_at_ten(tmp_path):
    h = tmp_path / "h"
    _db(h / "state.db", sessions=[dict(id=f"s{i}", started_at=NOW - H, output_tokens=0, estimated_cost_usd=i / 10) for i in range(15)])
    r = spend.compute(h, cfg(), "today", now=NOW)
    ex = r["waste"]["categories"][0]["examples"]
    assert len(ex) == 10 and ex[0]["id"] == "s14" and r["waste"]["categories"][0]["count"] == 15


def test_cache_share(home):
    r = spend.compute(home, cfg(), "today", now=NOW)
    # default d1: input 1000 + cache_read 3000 -> share over all input-side tokens
    assert 0 < r["cache"]["share"] < 1
    assert r["cache"]["read_tokens"] == 3000


def test_pace_vs_ceiling(home):
    r = spend.compute(home, cfg(ceiling=2.0), "month", now=NOW)
    t = r["pace"]["today"]
    assert t["budget"] == 2.0 and t["cost"] == pytest.approx(3.5) and t["status"] == "over" and t["used_pct"] == pytest.approx(1.75)
    assert r["pace"]["week"]["budget"] == 14.0 and r["pace"]["month"]["budget"] == 62.0
    assert spend.compute(home, cfg(), "month", now=NOW)["pace"]["set"] is False


def test_cards_by_session_id_and_window(home):
    k = home / "kanban/boards/main/kanban.db"
    k.parent.mkdir(parents=True)
    c = sqlite3.connect(k)
    c.executescript("""
    create table tasks(id text primary key, title text, assignee text, status text, session_id text);
    create table task_runs(id text primary key, task_id text, profile text, started_at int, ended_at int, outcome text);
    """)
    c.execute("insert into tasks values('T1','Direct card','agent:chief','done','c3')")
    c.execute("insert into tasks values('T2','Window card','agent:default','done',NULL)")
    c.execute("insert into task_runs values('r1','T2','default',?,?,'completed')", (int(NOW - 2 * H) - 10, int(NOW - H)))
    c.commit(); c.close()
    r = spend.compute(home, cfg(), "month", now=NOW)
    cards = {c["task_id"]: c for c in r["cards"]}
    assert cards["T1"]["cost"] == pytest.approx(0.75) and cards["T1"]["method"] == "session_id"
    assert cards["T2"]["method"] == "window" and cards["T2"]["cost"] == pytest.approx(0.5)   # d2 (cron) only; d1 is an interactive cli session
    assert r["missing"] == []


def test_missing_notes_without_kanban(home):
    r = spend.compute(home, cfg(), "month", now=NOW)
    assert r["cards"] == [] and r["missing"] and any("estimate" in n.lower() for n in r["data_notes"])
    assert any("subscription" in n.lower() for n in r["data_notes"])


def test_sensor_spend_cached_and_endpoint(home):
    s = Sensor(home=home, config=cfg())
    a = s.spend("today")
    assert s.spend("today") is a                    # cached
    assert s.spend("week") is not a
    assert a["range"] == "today"
