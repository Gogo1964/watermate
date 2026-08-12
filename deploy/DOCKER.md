# Running WaterMate in Docker on a Raspberry Pi

Short version: start it by hand with `docker compose up -d`, and let it come back
after a reboot either through the container's own restart policy (already in the
compose file) or through a small systemd unit that runs Compose at boot.

## 0. Prerequisites (once per Pi)

```bash
curl -fsSL https://get.docker.com | sh      # installs docker + the compose plugin
sudo usermod -aG docker "$USER"             # log out and back in for this to apply
docker compose version                      # sanity check
```

The installer already enables the Docker daemon at boot. Confirm it, because
everything below depends on it:

```bash
systemctl is-enabled docker                 # -> enabled
```

Then put the checkout somewhere permanent (`/opt/watermate` matches the rest of
the docs) and create the secrets file next to it:

```bash
cd /opt/watermate
cp .env.example .env && nano .env           # meter URL, SMTP credentials, TIMEZONE
```

`deploy/docker-compose.yml` reads `../.env`, so the file belongs in the project
root, not in `deploy/`. `TIMEZONE` (default `Europe/Berlin`) drives day
boundaries and report times inside the container — the host clock's timezone is
irrelevant, but the host clock itself must be right, so leave `systemd-timesyncd`
alone.

## 1. Starting it manually

```bash
cd /opt/watermate
docker compose -f deploy/docker-compose.yml up -d --build
```

The first build on a Pi takes a few minutes (`npm ci` on armhf/arm64); after
that `up -d` is instant. Drop `--build` once the `watermate:latest` image exists
and you have not changed the code.

Everyday commands, all from `/opt/watermate`:

```bash
docker compose -f deploy/docker-compose.yml ps        # is it up? is it healthy?
docker compose -f deploy/docker-compose.yml logs -f   # follow the log
docker compose -f deploy/docker-compose.yml restart
docker compose -f deploy/docker-compose.yml stop      # stop, keep the container
docker compose -f deploy/docker-compose.yml down      # stop and remove it
```

`down` removes the container but not the `watermate-data` volume, so the SQLite
database survives. Ad-hoc CLI calls run inside the live container:

```bash
docker compose -f deploy/docker-compose.yml exec watermate \
  node --disable-warning=ExperimentalWarning src/index.js --status
```

Same pattern for `--test-mail` or `--report YYYY-MM-DD`. Use `exec` rather than
`run`, so you don't get a second process writing the same database.

Updating to a new version:

```bash
cd /opt/watermate && git pull
docker compose -f deploy/docker-compose.yml up -d --build
```

Migrations run automatically at startup, so there is no separate step.

## 2. Starting it automatically after a reboot

### Option A — the restart policy alone (simplest)

`deploy/docker-compose.yml` already sets `restart: unless-stopped`. Combined
with an enabled Docker daemon that is all a reboot needs: containers that were
running when the Pi went down are started again when Docker comes up. Nothing to
install; you are done after the manual `up -d` above.

Two things to know about it:

- If you deliberately ran `stop` or `down`, the container stays down across the
  reboot. That is the "unless-stopped" part, and it is usually what you want.
- Docker restarts the container *as it was created*. Edits to
  `docker-compose.yml` or `.env` only take effect after you re-run
  `up -d` yourself.

### Option B — a systemd unit that runs Compose at boot

Use this if you want the compose file re-applied on every boot, a container
removed with `down` to come back anyway, and `systemctl`/`journalctl` as the
single control surface for the Pi's services:

```bash
sudo tee /etc/systemd/system/watermate-docker.service >/dev/null <<'EOF'
[Unit]
Description=WaterMate (Docker Compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/watermate
ExecStart=/usr/bin/docker compose -f deploy/docker-compose.yml up -d
ExecStop=/usr/bin/docker compose -f deploy/docker-compose.yml stop
ExecReload=/usr/bin/docker compose -f deploy/docker-compose.yml up -d --build
# The first build can take minutes on a Pi; don't let systemd time it out.
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now watermate-docker
```

Then `systemctl start|stop|reload watermate-docker` replaces the compose
commands above. The unit only reports whether Compose *succeeded*; the
application log still lives in `docker compose logs`, not in the journal.

Check `which docker` if the unit fails to start — systemd needs the absolute
path, and it is `/usr/bin/docker` from get.docker.com but `/usr/local/bin/docker`
in some manual installs.

### Do not run both deployment styles

`deploy/watermate.service` runs WaterMate natively on the host. Running it
alongside the container means two instances polling the meter and two sets of
alert mails. Pick one:

```bash
sudo systemctl disable --now watermate      # when switching to Docker
```

## 3. Verifying the reboot actually works

```bash
sudo reboot
# after it comes back:
docker ps                                                   # watermate, "Up ... (healthy)"
docker compose -f deploy/docker-compose.yml logs --since 5m
```

`healthy` comes from the Dockerfile healthcheck, which opens the database — it
takes up to a minute after boot to flip from `starting`.
