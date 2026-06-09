#!/bin/bash
# First-time setup for parkrun-explorer
pipenv install
pipenv run playwright install chromium
echo "Ready. Run 'pipenv run serve' to start the local server."
