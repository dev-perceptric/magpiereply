#!/usr/bin/env bash
# Publishes the website/ folder to the hostinger-site branch, with the site's files at the
# top level. Hostinger's Git deploy pulls that branch into public_html.
# Run from anywhere in the repo after the site changes:
#   bash website/tools/publish-hostinger.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
git subtree split --prefix=website -b hostinger-site
git push origin hostinger-site:hostinger-site
git branch -D hostinger-site
echo "Pushed hostinger-site. Hostinger deploys it on its own."
