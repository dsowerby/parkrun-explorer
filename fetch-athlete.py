#!/usr/bin/env python3
"""
fetch-athlete.py — scrapes a parkrun athlete's full run history.

Usage:
    pipenv run python fetch-athlete.py <ATHLETE_ID>

Output: docs/athletes/<ATHLETE_ID>.json
"""

from playwright.sync_api import sync_playwright
from datetime import date, datetime
import json
import sys
from pathlib import Path
from collections import defaultdict


def parse_time_to_secs(t):
    """'28:14' or '1:02:33' -> total seconds, or None."""
    if not t:
        return None
    parts = t.strip().split(':')
    try:
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    except (ValueError, IndexError):
        pass
    return None


def secs_to_mmss(secs):
    if secs is None:
        return None
    return f"{secs // 60}:{secs % 60:02d}"


def parse_date(raw):
    """'02/01/2016' or '2 Jan 2016' -> 'YYYY-MM-DD', or None."""
    if not raw:
        return None
    raw = raw.strip()
    for fmt in ('%d/%m/%Y', '%d %b %Y', '%d %B %Y'):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def scrape_athlete(athlete_id):
    url = f"https://www.parkrun.org.uk/parkrunner/{athlete_id}/all/"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=50)
        page    = browser.new_page()
        page.goto(url, wait_until="networkidle", timeout=60000)

        # Extract everything from each row in a single pass.
        # This keeps slug, date, time and PB in sync — no separate arrays.
        runs = page.eval_on_selector_all(
            "table#results tbody tr",
            r"""rows => rows.map(row => {
                const cells = Array.from(row.querySelectorAll('td'));
                const text  = cells.map(c => c.innerText.trim());

                // Slug: from any results link, matching any parkrun domain
                let slug = null;
                const link = row.querySelector('a[href*="/results/"]');
                if (link) {
                    const m = link.href.match(/[a-z0-9.-]+\/([^/]+)\/results\//);
                    if (m) slug = m[1];
                }

                // Date: cell matching dd/mm/yyyy
                let runDate = null;
                for (const t of text) {
                    if (/^\d{2}\/\d{2}\/\d{4}$/.test(t) ||
                        /^\d{1,2}\s[A-Za-z]+\s\d{4}$/.test(t)) {
                        runDate = t;
                        break;
                    }
                }

                // Time: cell matching m:ss or mm:ss or h:mm:ss, between 1 min and 3 hrs
                let runTime = null;
                for (const t of text) {
                    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) {
                        const parts = t.split(':').map(Number);
                        const secs = parts.length === 2
                            ? parts[0]*60 + parts[1]
                            : parts[0]*3600 + parts[1]*60 + parts[2];
                        if (secs >= 60 && secs <= 10800) {
                            runTime = t;
                            break;
                        }
                    }
                }

                // PB flag: any cell containing 'PB' (case-insensitive, whole word)
                const isPB = text.some(t => /\bPB\b/i.test(t));

                return { slug, date: runDate, time: runTime, pb: isPB };
            })"""
        )

        browser.close()

    return runs


def build_athlete_data(athlete_id, runs):
    events = defaultdict(lambda: {
        'count':          0,
        'first':          None,
        'last':           None,
        'best_time_secs': None,
        'pb':             False,
    })

    total_runs = 0

    for run in runs:
        slug = run.get('slug')
        if not slug:
            continue

        raw_date = run.get('date')
        raw_time = run.get('time')
        is_pb    = run.get('pb', False)

        run_date = parse_date(raw_date)
        time_secs = parse_time_to_secs(raw_time)

        ev = events[slug]
        ev['count'] += 1
        total_runs  += 1

        if run_date:
            if ev['first'] is None or run_date < ev['first']:
                ev['first'] = run_date
            if ev['last'] is None or run_date > ev['last']:
                ev['last'] = run_date

        if time_secs:
            if ev['best_time_secs'] is None or time_secs < ev['best_time_secs']:
                ev['best_time_secs'] = time_secs

        if is_pb:
            ev['pb'] = True

    clean_events = {
        slug: {
            'count':     ev['count'],
            'first':     ev['first'],
            'last':      ev['last'],
            'best_time': secs_to_mmss(ev['best_time_secs']),
            'pb':        ev['pb'],
        }
        for slug, ev in events.items()
    }

    home_event = max(clean_events, key=lambda s: clean_events[s]['count']) \
                 if clean_events else None

    return {
        'athlete_id': str(athlete_id),
        'fetched':    date.today().isoformat(),
        'total_runs': total_runs,
        'home_event': home_event,
        'events':     clean_events,
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <ATHLETE_ID>")
        sys.exit(1)

    athlete_id = sys.argv[1]
    print(f"Fetching athlete {athlete_id}...")

    runs = scrape_athlete(athlete_id)
    print(f"  {len(runs)} rows found")

    data = build_athlete_data(athlete_id, runs)
    print(f"  {data['total_runs']} runs across {len(data['events'])} events")
    print(f"  home event: {data['home_event']}")

    script_dir  = Path(__file__).resolve().parent
    output_path = script_dir / "docs" / "athletes" / f"{athlete_id}.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open("w") as f:
        json.dump(data, f, separators=(',', ':'))

    print(f"  saved → {output_path}")
