# POS compatibility fixtures

The original backend, Compose configuration, SQL schema and seed, and demo catalog in this directory support Silaut's compatibility checks. The included k6 scenario runs a short mixed workload against the extended backend.

From the [Silaut project root](../../README.md), run `bash scripts/research-ec2.sh` with Docker Compose v2. It starts the baseline and extended backend in separate projects and writes new results under the ignored `verification/v2/` directory.
