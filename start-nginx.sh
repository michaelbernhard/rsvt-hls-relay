#!/bin/bash
set -e

PORT="${PORT:-8080}"
echo "Configuring Nginx to listen on Railway PORT: $PORT"

# Replace whatever listen line is in nginx.conf with the actual assigned PORT
sed -i "s/listen .*/listen $PORT default_server;/g" /etc/nginx/nginx.conf

echo "Starting Nginx on port $PORT..."
exec nginx -g "daemon off;"
