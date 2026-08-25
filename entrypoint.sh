#!/bin/bash

mkdir -p /var/www/hls /run/nginx

APP_PORT=${PORT:-8080}

cat <<EOF > /etc/nginx/nginx.conf
worker_processes 1;
pid /run/nginx/nginx.pid;
daemon off;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    
    types {
        application/x-mpegURL m3u8;
        application/vnd.apple.mpegurl m3u8;
        audio/aac aac;
        audio/mp4 m4s mp4;
        video/iso.segment m4s;
    }

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;

    server {
        listen 80 default_server;
        listen 8080 default_server;
        listen $APP_PORT default_server;
        server_name _;

        location /hls {
            root /var/www;
            
            add_header Access-Control-Allow-Origin * always;
            add_header Access-Control-Allow-Methods 'GET, HEAD, OPTIONS' always;
            add_header Access-Control-Allow-Headers '*' always;
            
            location ~* \.m3u8$ {
                root /var/www;
                add_header Cache-Control "no-cache, no-store, must-revalidate" always;
                add_header Access-Control-Allow-Origin * always;
                add_header Content-Type "application/x-mpegURL" always;
            }
            
            location ~* \.(m4s|mp4|aac)$ {
                root /var/www;
                add_header Cache-Control "max-age=60" always;
                add_header Access-Control-Allow-Origin * always;
            }
        }

        location /health {
            return 200 'OK';
            add_header Content-Type text/plain;
        }
    }
}
EOF

STREAM_SOURCE=${STREAM_SOURCE:-"http://stream.radiojar.com/c1wchedg76bwv"}

# Start FFmpeg in background loop
(
    while true; do
        echo "Starting FFmpeg HLS transcode from: $STREAM_SOURCE"
        
        ffmpeg -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
            -err_detect ignore_err \
            -i "$STREAM_SOURCE" \
            -c:a aac -b:a 256k -ar 44100 -ac 2 \
            -f hls \
            -hls_time 4 \
            -hls_list_size 6 \
            -hls_flags delete_segments+append_list+omit_endlist \
            -hls_segment_type fmp4 \
            -hls_fmp4_init_filename 'init.mp4' \
            -hls_segment_filename '/var/www/hls/segment_%05d.m4s' \
            /var/www/hls/live.m3u8
            
        echo "FFmpeg exited, restarting in 2 seconds..."
        sleep 2
    done
) &

# Run Nginx in foreground as PID 1 so container stays permanently active
echo "Starting Nginx in foreground on port $APP_PORT, 80, 8080..."
exec nginx
