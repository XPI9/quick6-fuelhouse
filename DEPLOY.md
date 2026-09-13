# Deploying Quick6 FuelHouse to the VPS

Runs alongside XPI Schedule + XPI BD on the same Hostinger VPS (45.82.72.36),
behind the same Caddy. Binds to the Docker bridge `172.18.0.1:3300`; Caddy
reverse-proxies the subdomain to it. ~10 minutes.

## 1. DNS — point the subdomain at the VPS
In Hostinger DNS for xpisolutions.com, add an **A record**:
- Name: `fuel`   →   Value: `45.82.72.36`
(so **fuel.xpisolutions.com** resolves to the VPS. Swap for Keith's own domain later.)

## 2. Clone the repo on the VPS
```
git clone https://github.com/XPI9/quick6-fuelhouse.git /opt/quick6-fuelhouse
```

## 3. Create the `.env` (⚠ use base64 — the Hostinger web console mangles long keys)
Easiest: SSH in and use nano:
```
nano /opt/quick6-fuelhouse/.env
```
Paste (with your real Anthropic key — same one BD uses):
```
ANTHROPIC_API_KEY=sk-ant-...
FUEL_MODEL=claude-sonnet-5
FUEL_LIMIT=30
PORT=3300
```
Save: Ctrl+O, Enter, Ctrl+X.

## 4. Add the Caddy block
Edit Schedule's Caddyfile (the one already running):
```
nano /opt/xpi-schedule/caddy/Caddyfile
```
Add at the bottom:
```
fuel.xpisolutions.com {
    reverse_proxy 172.18.0.1:3300
}
```
Reload Caddy:
```
cd /opt/xpi-schedule && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```
(If that errors, `docker compose restart caddy` from /opt/xpi-schedule.)

## 5. Build + start
```
sh /opt/quick6-fuelhouse/up.sh
```

## 6. Verify
```
curl https://fuel.xpisolutions.com/api/health
```
Should return `{"ok":true,"anthropicKey":true,...}`. Then open **fuel.xpisolutions.com** in a browser.

## Updating later
Push to GitHub, then on the VPS: `sh /opt/quick6-fuelhouse/up.sh`
