#!/bin/bash
set -e

mkdir -p /var/log/icecast /etc/icecast2
touch /var/log/icecast/error.log /var/log/icecast/access.log
chown -R icecast:icecast /var/log/icecast /etc/icecast2

APP_PORT="${PORT:-8080}"
echo "Configuring Icecast2 on port: $APP_PORT..."

# Replace port in icecast.xml if assigned dynamically by Railway
sed -i "s|<port>.*</port>|<port>$APP_PORT</port>|g" /etc/icecast2/icecast.xml

# Start Icecast2 in background
echo "Starting Icecast2 server..."
icecast -c /etc/icecast2/icecast.xml &

# Tail icecast logs in background so we see all diagnostics
tail -F /var/log/icecast/error.log &

# Start stream feeder in foreground
echo "Starting stream feeder..."
exec node /stream-feeder.js
