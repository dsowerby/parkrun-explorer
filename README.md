# parkrun explorer

A map-based tool for exploring parkrun events worldwide, tracking your visits, and planning tourist runs.

## Live site

[dsowerby.github.io/parkrun-explorer](https://dsowerby.github.io/parkrun-explorer)

## Structure

```
docs/           — served by GitHub Pages
  index.html
  map.js
  map.css
  athletes/     — per-athlete visit history JSON files
fetch-athlete.py  — scrapes a single athlete's history via Playwright
Pipfile           — Python dependencies for local development
.github/
  workflows/
    refresh-athletes.yml  — weekly scheduled refresh of all athlete files
```

## Local development

```bash
pipenv install
pipenv run playwright install chromium
pipenv run serve        # http://localhost:8000/docs
```

## Adding an athlete

```bash
pipenv run python fetch-athlete.py <ATHLETE_ID>
```

Writes `docs/athletes/<ATHLETE_ID>.json`. Commit and push — the GitHub Action will keep it fresh weekly from then on.

## Data sources

- **Events** — fetched live via Cloudflare Worker proxy (no caching needed)
- **Athlete history** — scraped locally via Playwright, committed to the repo
