#!/usr/bin/env bash
# Run on a new Ubuntu EC2 host as ubuntu. Uses the official Docker apt repository.
set -euo pipefail
. /etc/os-release
[[ "$ID" == ubuntu ]] || { echo 'This setup script requires Ubuntu.';exit 1; }
sudo apt-get update
sudo apt-get install -y ca-certificates curl unzip openssl python3
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
arch=$(dpkg --print-architecture)
printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$VERSION_CODENAME" "$arch" | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
echo 'Docker installed. Exit SSH and reconnect so your docker group membership takes effect.'
