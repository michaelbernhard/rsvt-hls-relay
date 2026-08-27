#!/bin/bash
set -e

PORT="${PORT:-8080}"
echo "Configuring Nginx to listen on Railway PORT: $PORT"

sed -i "s/listen 8080 default_server;/listen $PORT default_server;/g" /etc/nginx/nginx.conf

echo "Testing Nginx configuration..."
nginx -t

echo "Starting Nginx on port $PORT..."
exec nginx -g "daemon off;"
