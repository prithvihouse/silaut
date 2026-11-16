#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Run these before deploying the demo the first time. Repeat anytime: demo data is never reset.
bash scripts/research-ec2.sh
bash scripts/test-ec2.sh
echo 'EC2 backend verification passed. Browser and public HTTPS checks are described in docs/AWS_DEPLOYMENT.md.'
