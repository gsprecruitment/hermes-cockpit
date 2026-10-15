"""Spend insights: pure aggregation over the sessions Hermes records, plus the read-only
loaders that feed it.

Everything here is *estimated at API prices*: Hermes writes ``estimated_cost_usd`` per
session from a price table and ``actual_cost_usd`` only when a provider reports one (rare).
Subscription plans (Alibaba Token Plan, Claude subscription) have no per-token price, so
their sessions are either unpriced or priced as if they were metered. The ``data_notes``
list in the result says so; the UI repeats it.

Loaders tolerate missing files, locked DBs and unknown schemas (they return nothing).
"""

from __future__ import annotations

import calendar
import re
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

from . import sources
from .config import CockpitConfig

RANGES = ("today", "week", "month", "30d")
DAY = 86400

SESSION_COLS = (
    "id", "source", "model", "billing_provider", "billing_mode", "started_at", "ended_at", "end_reason",
    "message_count", "tool_call_count", "api_call_count", "input_tokens", "output_tokens", "cache_read_tokens",
    "cache_write_tokens", "reasoning_tokens", "estimated_cost_usd", "actual_cost_usd", "cost_status", "cost_source",
    "title", "parent_session_id",
)
USAGE_COLS = (
    "session_id", "model", "billing_provider", "billing_mode", "task", "api_call_count", "input_tokens", "output_tokens",
    "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "estimated_cost_usd", "actual_cost_usd", "cost_status",
    "first_seen",
)
ERROR_RE = re.compile(r"error|refus|fail|crash|timeout|timed_out|exception|abort|overload|rate.?limit", re.I)
ORPHAN_RE = re.compile(r"orphan", re.I)
UNPRICED = ("", "unknown", "unpriced", "missing", "none")


# ── time windows (local timezone) ────────────────────────────────────────────────────────


def _midnight(dt: datetime) -> datetime:
    return dt.replace(hour=0, minute=0, second=0, microsecond=0)


def windows(now: float) -> dict[str, dict[str, float]]:
    """Start/end epoch per range. Week starts Monday, month on the 1st, 30d = today + 29 days back."""
    dt = datetime.fromtimestamp(now)
    today = _midnight(dt)
    week = today - timedelta(days=today.weekday())
    month = today.replace(day=1)
    d30 = today - timedelta(days=29)
    out = {}
    for name, start in (("today", today), ("week", week), ("month", month), ("30d", d30)):
        out[name] = {"start": start.timestamp(), "end": now}
    return out


def _day_key(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def _days_between(start: float, end: float) -> list[str]:
    d = _midnight(datetime.fromtimestamp(start))
    last = _midnight(datetime.fromtimestamp(end))
    out = []
    while d <= last:
        out.append(d.strftime("%Y-%m-%d"))
        d += timedelta(days=1)
        d = _midnight(d)  # DST-safe
    return out


# ── loaders ──────────────────────────────────────────────────────────────────────────────


def _cols(conn, table: str) -> set[str]:
    return {r["name"] for r in sources._rows(conn, f"pragma table_info({table})")}


def read_sessions(profile: str, since: float, home: Path | None = None) -> list[dict[str, Any]]:
    conn = sources._ro(sources.profile_home(profile, home) / "state.db")
    if conn is None:
        return []
    try:
        have = _cols(conn, "sessions")
        if "id" not in have or "started_at" not in have:
            return []
        sel = ", ".join(c if c in have else f"NULL as {c}" for c in SESSION_COLS)
        rows = sources._rows(conn, f"select {sel} from sessions where started_at >= ?", (since,))
        out = []
        for r in rows:
            d = dict(r)
            d["profile"] = profile
            out.append(d)
        return out
    finally:
        conn.close()


def read_model_usage(profile: str, since: float, home: Path | None = None) -> list[dict[str, Any]]:
    conn = sources._ro(sources.profile_home(profile, home) / "state.db")
    if conn is None:
        return []
    try:
        have = _cols(conn, "session_model_usage")
        if not {"session_id", "model"} <= have:
            return []
        sel = ", ".join(c if c in have else f"NULL as {c}" for c in USAGE_COLS)
        where = "where first_seen >= ?" if "first_seen" in have else ""
        rows = sources._rows(conn, f"select {sel} from session_model_usage {where}", (since,) if where else ())
        out = []
        for r in rows:
            d = dict(r)
            d["profile"] = profile
            out.append(d)
        return out
    finally:
        conn.close()


def read_card_links(home: Path | None, boards: list[str] | None, since: float) -> dict[str, Any]:
    """Tasks (with their ``session_id`` when set) and runs, for attributing spend to cards."""
    tasks: list[dict[str, Any]] = []
    runs: list[dict[str, Any]] = []
    for board, db in sources.kanban_db_paths(home, boards):
        conn = sources._ro(db)
        if conn is None:
            continue
        try:
            tcols = _cols(conn, "tasks")
            if {"id", "title"} <= tcols:
                sel = ", ".join(c if c in tcols else f"NULL as {c}" for c in ("id", "title", "assignee", "status", "session_id"))
                for r in sources._rows(conn, f"select {sel} from tasks"):
                    d = dict(r)
                    d["board"] = board
                    tasks.append(d)
            rcols = _cols(conn, "task_runs")
            if {"id", "task_id", "profile", "started_at"} <= rcols:
                sel = ", ".join(c if c in rcols else f"NULL as {c}" for c in ("id", "task_id", "profile", "started_at", "ended_at", "outcome"))
                for r in sources._rows(conn, f"select {sel} from task_runs where started_at >= ?", (int(since) - 3600,)):
                    d = dict(r)
                    d["board"] = board
                    runs.append(d)
        finally:
            conn.close()
    return {"tasks": tasks, "runs": runs}


# ── aggregation helpers ──────────────────────────────────────────────────────────────────


def _n(v: Any) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _tok(s: dict[str, Any]) -> int:
    return int(_n(s.get("input_tokens")) + _n(s.get("output_tokens")))


def provider_info(provider: str | None, mode: str | None = None, model: str | None = None) -> dict[str, str]:
    """Normalised provider key/label/kind. ``kind`` is ``subscription`` (no per-token price),
    ``metered`` (priced per token) or ``unknown``."""
    p = (provider or "").strip().lower()
    m = (mode or "").strip().lower()
    if not p:
        return {"key": "unknown", "label": "Unknown provider", "kind": "unknown"}
    if p.startswith("alibaba"):
        return {"key": "alibaba-token-plan", "label": "Alibaba Token Plan", "kind": "subscription"}
    if "subscription" in p or "subscription" in m or p in ("claude-code", "claude-cli"):
        return {"key": "claude-subscription", "label": "Claude subscription", "kind": "subscription"}
    if p == "anthropic":
        return {"key": "anthropic", "label": "Anthropic API", "kind": "metered"}
    if p == "nous":
        return {"key": "nous", "label": "Nous Portal", "kind": "metered"}
    if p.startswith("custom:"):
        return {"key": p, "label": "Custom: " + p[7:], "kind": "unknown"}
    if p == "custom":
        return {"key": "custom", "label": "Custom endpoint", "kind": "unknown"}
    return {"key": p, "label": p, "kind": "metered"}


def waste_flags(s: dict[str, Any]) -> list[str]:
    flags = []
    toks = _tok(s)
    if int(_n(s.get("output_tokens"))) == 0 and (toks > 0 or _n(s.get("estimated_cost_usd")) > 0):
        flags.append("zero_output")
    if int(_n(s.get("message_count"))) <= 1:
        flags.append("single_message")
    reason = str(s.get("end_reason") or "")
    if reason and ERROR_RE.search(reason):
        flags.append("error_end")
    elif reason and ORPHAN_RE.search(reason):
        flags.append("orphaned")
    status = str(s.get("cost_status") or "").strip().lower()
    if status in UNPRICED and toks > 0:
        flags.append("unpriced")
    return flags


WASTE_META = {
    "zero_output": ("Zero output tokens", True),
    "single_message": ("One message or fewer", True),
    "error_end": ("Ended with an error or refusal", True),
    "orphaned": ("Reaped as orphan (session left open, not necessarily wasted)", False),
    "unpriced": ("Cost status unknown / unpriced", False),  # not waste per se: spend we cannot see
}
WASTE_ORDER = ("zero_output", "single_message", "error_end", "orphaned", "unpriced")


def _example(s: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": s.get("id"), "profile": s.get("profile"), "model": s.get("model"), "title": (s.get("title") or "")[:120],
        "started_at": s.get("started_at"), "cost": round(_n(s.get("estimated_cost_usd")), 6), "tokens": _tok(s),
        "source": s.get("source"), "end_reason": s.get("end_reason"), "flags": waste_flags(s),
    }


class _Acc:
    __slots__ = ("cost", "actual", "actual_n", "tin", "tout", "cr", "cw", "reas", "sessions", "calls", "waste_cost", "waste_n", "waste_tok")

    def __init__(self) -> None:
        self.cost = self.actual = 0.0
        self.actual_n = self.sessions = self.calls = self.waste_n = 0
        self.tin = self.tout = self.cr = self.cw = self.reas = self.waste_tok = 0
        self.waste_cost = 0.0

    def add(self, s: dict[str, Any], *, count_session: bool = True, wasted: bool = False) -> None:
        self.cost += _n(s.get("estimated_cost_usd"))
        a = _n(s.get("actual_cost_usd"))
        if a > 0:
            self.actual += a
            self.actual_n += 1
        self.tin += int(_n(s.get("input_tokens")))
        self.tout += int(_n(s.get("output_tokens")))
        self.cr += int(_n(s.get("cache_read_tokens")))
        self.cw += int(_n(s.get("cache_write_tokens")))
        self.reas += int(_n(s.get("reasoning_tokens")))
        self.calls += int(_n(s.get("api_call_count")))
        if count_session:
            self.sessions += 1
        if wasted:
            self.waste_n += 1
            self.waste_cost += _n(s.get("estimated_cost_usd"))
            self.waste_tok += int(_n(s.get("input_tokens")) + _n(s.get("output_tokens")))

    def cache_share(self) -> float:
        denom = self.tin + self.cr + self.cw
        return round(self.cr / denom, 4) if denom else 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "cost": round(self.cost, 6), "cost_actual": round(self.actual, 6), "actual_sessions": self.actual_n,
            "tokens": self.tin + self.tout, "tokens_in": self.tin, "tokens_out": self.tout,
            "tokens_cache_read": self.cr, "tokens_cache_write": self.cw, "tokens_reasoning": self.reas,
            "sessions": self.sessions, "api_calls": self.calls,
            "avg_cost": round(self.cost / self.sessions, 6) if self.sessions else 0.0,
            "waste_cost": round(self.waste_cost, 6), "waste_sessions": self.waste_n, "waste_tokens": self.waste_tok,
            "cache_share": self.cache_share(),
        }


def _group(rows: Iterable[tuple[str, dict[str, Any], dict[str, Any]]]) -> list[dict[str, Any]]:
    """rows: (key, extra fields, session). Returns accumulators sorted by cost desc."""
    accs: dict[str, _Acc] = {}
    extras: dict[str, dict[str, Any]] = {}
    for key, extra, s in rows:
        a = accs.setdefault(key, _Acc())
        extras.setdefault(key, extra)
        a.add(s, wasted=bool(s.get("_waste")))
    out = [{"key": k, **extras[k], **a.to_dict()} for k, a in accs.items()]
    out.sort(key=lambda r: (-r["cost"], -r["tokens"], r["key"]))
    return out


def _totals(sessions: list[dict[str, Any]]) -> dict[str, Any]:
    a = _Acc()
    for s in sessions:
        a.add(s, wasted=bool(s.get("_waste")))
    return a.to_dict()


def attribute_cards(sessions: list[dict[str, Any]], links: dict[str, Any], limit: int = 15) -> list[dict[str, Any]]:
    """Cost per kanban card. Direct link = ``tasks.session_id``. Otherwise a session of the run's
    profile that started inside the run window and is not an interactive source (method ``window``,
    an estimate: concurrent sessions of the same profile can be mis-assigned)."""
    by_id = {s["id"]: s for s in sessions}
    tasks = {(t["board"], t["id"]): t for t in links.get("tasks", [])}
    used: set[str] = set()
    cards: dict[tuple[str, str], dict[str, Any]] = {}

    def card_of(board: str, tid: str) -> dict[str, Any]:
        t = tasks.get((board, tid)) or {}
        return cards.setdefault((board, tid), {
            "board": board, "task_id": tid, "title": t.get("title") or tid, "assignee": t.get("assignee"),
            "status": t.get("status"), "cost": 0.0, "tokens": 0, "sessions": 0, "runs": 0, "method": "", "session_ids": [],
        })

    for (board, tid), t in tasks.items():
        sid = t.get("session_id")
        if sid and sid in by_id and sid not in used:
            used.add(sid)
            s = by_id[sid]
            c = card_of(board, tid)
            c["cost"] += _n(s.get("estimated_cost_usd")); c["tokens"] += _tok(s); c["sessions"] += 1; c["session_ids"].append(sid)
            c["method"] = c["method"] if c["method"] in ("", "session_id") else "mixed"; c["method"] = c["method"] or "session_id"
    interactive = {"whatsapp", "desktop", "cli", "tui", "telegram", "discord", "slack"}
    by_profile: dict[str, list[dict[str, Any]]] = {}
    for s in sessions:
        if s["id"] not in used and str(s.get("source") or "") not in interactive:
            by_profile.setdefault(s["profile"], []).append(s)
    counted_runs: set[tuple[str, str]] = set()
    for run in links.get("runs", []):
        start = _n(run.get("started_at"))
        end = _n(run.get("ended_at")) or start + 900
        counted_runs.add((run["board"], run["task_id"]))
        for s in by_profile.get(run.get("profile") or "", []):
            if s["id"] in used:
                continue
            if start - 5 <= _n(s.get("started_at")) <= end + 5:
                used.add(s["id"])
                c = card_of(run["board"], run["task_id"])
                c["cost"] += _n(s.get("estimated_cost_usd")); c["tokens"] += _tok(s); c["sessions"] += 1; c["session_ids"].append(s["id"])
                c["method"] = "window" if not c["method"] else ("window" if c["method"] == "window" else "mixed")
    for key in counted_runs:
        if key in cards:
            cards[key]["runs"] = sum(1 for r in links.get("runs", []) if (r["board"], r["task_id"]) == key)
    out = sorted(cards.values(), key=lambda c: (-c["cost"], -c["tokens"]))[:limit]
    for c in out:
        c["cost"] = round(c["cost"], 6)
        c["session_ids"] = c["session_ids"][:5]
    return out


def pace(cost_by_range: dict[str, float], ceiling: float | None, now: float) -> dict[str, Any]:
    """Spend against ``spend_ceiling_usd`` (a per-day figure): today, this week, this month."""
    dt = datetime.fromtimestamp(now)
    mid = _midnight(dt)
    frac_today = max(0.04, (now - mid.timestamp()) / DAY)
    week_days_done = dt.weekday() + frac_today
    dim = calendar.monthrange(dt.year, dt.month)[1]
    month_done = (dt.day - 1) + frac_today
    out: dict[str, Any] = {"ceiling_day": ceiling, "set": bool(ceiling)}
    for name, done, total in (("today", frac_today, 1), ("week", week_days_done, 7), ("month", month_done, dim)):
        cost = cost_by_range.get(name, 0.0)
        projected = cost / done * total if done else cost
        row = {"cost": round(cost, 6), "projected": round(projected, 6), "elapsed_frac": round(done / total, 4), "days": total}
        if ceiling:
            budget = ceiling * total
            row.update({"budget": round(budget, 4), "used_pct": round(cost / budget, 4), "projected_pct": round(projected / budget, 4),
                        "status": "over" if cost > budget else ("risk" if projected > budget else "ok")})
        out[name] = row
    return out


def build_spend(sessions: list[dict[str, Any]], usage: list[dict[str, Any]], links: dict[str, Any], *, range_name: str,
                groups: list[tuple[str, str, list[str]]], other_label: str, ceiling: float | None, now: float,
                profiles: list[str] | None = None) -> dict[str, Any]:
    """Pure: everything the Spend view needs. ``groups`` = (id, label, profiles)."""
    if range_name not in RANGES:
        range_name = "month"
    win = windows(now)
    for s in sessions:
        s["_flags"] = waste_flags(s)
        s["_waste"] = any(WASTE_META[f][1] for f in s["_flags"])
    in_win = {n: [s for s in sessions if _n(s.get("started_at")) >= w["start"]] for n, w in win.items()}
    sel = in_win[range_name]
    totals = {n: _totals(in_win[n]) for n in ("today", "week", "month", "30d")}

    prof_group: dict[str, tuple[str, str]] = {}
    for gid, label, members in groups:
        for p in members:
            prof_group.setdefault(p, (gid, label))

    by_profile = _group((s["profile"], {"profile": s["profile"], "department": prof_group.get(s["profile"], ("other", other_label))[1]}, s) for s in sel)
    by_department = _group((prof_group.get(s["profile"], ("other", other_label))[0],
                            {"label": prof_group.get(s["profile"], ("other", other_label))[1]}, s) for s in sel)
    by_source = _group((str(s.get("source") or "unknown"), {"label": str(s.get("source") or "unknown")}, s) for s in sel)

    def prov(s: dict[str, Any]) -> dict[str, str]:
        return provider_info(s.get("billing_provider"), s.get("billing_mode"), s.get("model"))

    by_provider = _group((prov(s)["key"], {"label": prov(s)["label"], "kind": prov(s)["kind"]}, s) for s in sel)
    sel_ids = {s["id"] for s in sel}
    usage_sel = [dict(u, _waste=False) for u in usage if u.get("session_id") in sel_ids]
    model_src = "session_model_usage" if usage_sel else "sessions"
    if usage_sel:
        for u in usage_sel:
            u["model"] = u.get("model") or "unknown"
        by_model = _group((f"{u['model']}|{prov(u)['key']}", {"model": u["model"], "label": u["model"], "provider": prov(u)["label"], "kind": prov(u)["kind"]}, u)
                          for u in usage_sel)
        # sessions count per model row is per usage row; make it distinct sessions
        ids: dict[str, set[str]] = {}
        for u in usage_sel:
            ids.setdefault(f"{u['model']}|{prov(u)['key']}", set()).add(u["session_id"])
        for r in by_model:
            r["sessions"] = len(ids.get(r["key"], ()))
            r["avg_cost"] = round(r["cost"] / r["sessions"], 6) if r["sessions"] else 0.0
    else:
        by_model = _group((f"{s.get('model') or 'unknown'}|{prov(s)['key']}", {"model": s.get("model") or "unknown", "label": s.get("model") or "unknown",
                                                                             "provider": prov(s)["label"], "kind": prov(s)["kind"]}, s) for s in sel)

    days = _days_between(win[range_name]["start"], now)
    series = {d: {"date": d, "cost": 0.0, "tokens": 0, "sessions": 0, "by_provider": {}} for d in days}
    for s in sel:
        d = series.get(_day_key(_n(s.get("started_at"))))
        if d is None:
            continue
        d["cost"] += _n(s.get("estimated_cost_usd")); d["tokens"] += _tok(s); d["sessions"] += 1
        pl = prov(s)["label"]
        d["by_provider"][pl] = d["by_provider"].get(pl, 0.0) + _n(s.get("estimated_cost_usd"))
    by_day = []
    for d in days:
        r = series[d]
        r["cost"] = round(r["cost"], 6)
        r["by_provider"] = {k: round(v, 6) for k, v in sorted(r["by_provider"].items())}
        by_day.append(r)

    # waste
    waste_cats = []
    for fid in WASTE_ORDER:
        hit = [s for s in sel if fid in s["_flags"]]
        hit.sort(key=lambda s: (-_n(s.get("estimated_cost_usd")), -_tok(s)))
        waste_cats.append({
            "id": fid, "label": WASTE_META[fid][0], "counts_as_waste": WASTE_META[fid][1], "count": len(hit),
            "tokens": sum(_tok(s) for s in hit), "cost": round(sum(_n(s.get("estimated_cost_usd")) for s in hit), 6),
            "examples": [_example(s) for s in hit[:10]],
        })
    wasted = [s for s in sel if s["_waste"]]
    wt = totals[range_name]
    waste = {
        "sessions": len(wasted), "tokens": sum(_tok(s) for s in wasted), "cost": round(sum(_n(s.get("estimated_cost_usd")) for s in wasted), 6),
        "cost_pct": round(sum(_n(s.get("estimated_cost_usd")) for s in wasted) / wt["cost"], 4) if wt["cost"] else 0.0,
        "sessions_pct": round(len(wasted) / wt["sessions"], 4) if wt["sessions"] else 0.0,
        "categories": waste_cats,
    }

    cards = attribute_cards(sel, links)
    missing = []
    if not links.get("tasks") and not links.get("runs"):
        missing.append("No kanban tasks or runs found, so no cost per card.")
    elif not cards:
        missing.append("No session could be linked to a card: tasks.session_id is empty and no run window matched a non-interactive session.")
    unpriced_prov = [p for p in by_provider if p["kind"] == "subscription"]
    notes = [
        "Costs are estimates at API list prices (estimated_cost_usd), not invoices.",
        f"Actual provider-reported cost exists for {wt['actual_sessions']} of {wt['sessions']} sessions in this range." if wt["sessions"] else "No sessions in this range.",
        "Subscription plans (Alibaba Token Plan, Claude subscription) have no per-token price: their sessions are unpriced or priced as if metered, so real marginal cost may be zero while the estimate is not.",
        "Hermes records no invoice or plan-fee data, so estimated spend cannot be reconciled with what is billed.",
        "Per-model and per-provider panels use session_model_usage (one row per session x model x task) when present; that can differ slightly from the session totals." if model_src == "session_model_usage"
        else "session_model_usage had no rows in range, so models are taken from sessions.model (one model per session).",
        "Cards are linked through tasks.session_id (set for one running session) and by run time window; task_runs carry no session id, so per-card cost is partial.",
        "Sessions are counted by started_at in local time; a long session is attributed wholly to its start day.",
        "Waste flags overlap (a session can be in several categories); the waste total counts each session once. Orphaned and unpriced are shown but not counted as waste (an orphan-reaped session may have done real work).",
    ]
    if unpriced_prov:
        notes.append("Subscription providers in this range: " + ", ".join(p["label"] for p in unpriced_prov) + ".")

    return {
        "range": range_name, "window": {"start": win[range_name]["start"], "end": now}, "ts": now,
        "totals": totals,
        "selected": wt,
        "by_profile": by_profile, "by_department": by_department, "by_model": by_model, "by_provider": by_provider,
        "by_source": by_source, "by_day": by_day,
        "providers": [p["label"] for p in by_provider],
        "cards": cards, "missing": missing,
        "waste": waste,
        "cache": {"read_tokens": wt["tokens_cache_read"], "write_tokens": wt["tokens_cache_write"], "input_tokens": wt["tokens_in"], "share": wt["cache_share"]},
        "pace": pace({n: totals[n]["cost"] for n in totals}, ceiling, now),
        "model_source": model_src,
        "data_notes": notes,
        "profiles_scanned": len(profiles or []),
    }


# ── entry point used by the sensor ───────────────────────────────────────────────────────


def compute(home: Path, config: CockpitConfig, range_name: str = "month", now: float | None = None) -> dict[str, Any]:
    now = now or time.time()
    win = windows(now)
    since = min(w["start"] for w in win.values())
    profiles = sources.discover_profiles(home)
    sessions: list[dict[str, Any]] = []
    usage: list[dict[str, Any]] = []
    for p in profiles:
        sessions.extend(read_sessions(p, since, home))
        usage.extend(read_model_usage(p, since, home))
    links = read_card_links(home, config.kanban_boards, since)
    groups = [(g.id, g.label, g.profiles) for g in config.groups]
    return build_spend(sessions, usage, links, range_name=range_name, groups=groups, other_label=config.other_group_label,
                       ceiling=config.spend_ceiling_usd, now=now, profiles=profiles)
