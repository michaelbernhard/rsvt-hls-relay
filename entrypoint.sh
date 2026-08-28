#!/bin/bash
set -e

mkdir -p /var/log/icecast
chown -R icecast:icecast /var/log/icecast

APP_PORT="${PORT:-8080}"
echo "Configuring Icecast2 on port: $APP_PORT..."

# Replace port in icecast.xml if assigned dynamically by Railway
sed -i "s|<port>.*</port>|<port>$APP_PORT</port>|g" /etc/icecast2/icecast.xml

# Start Icecast2 in background
echo "Starting Icecast2 server..."
icecast -c /etc/icecast2/icecast.xml &

# Start stream feeder in foreground to keep container running
echo "Starting stream feeder..."
exec node /stream-feeder.js
