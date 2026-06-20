#!/usr/bin/env bash
items=(docs/athletes/*.json)
for (( i=0; i<${#items[@]}; i++ )); do
  (( i )) && sleep 5
  item=$(basename -s .json "${items[i]}")
  pipenv run ./fetch-athlete.py "$item"
done
