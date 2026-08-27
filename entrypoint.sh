#!/bin/bash
set +e

mkdir -p /var/www/hls /run

APP_PORT="${PORT:-8080}"
echo "Configuring Nginx on port: $APP_PORT and 8080..."

# If PORT is different from 8080 and 80, replace placeholder, otherwise clean it
if [ "$APP_PORT" != "8080" ] && [ "$APP_PORT" != "80" ]; then
    sed -i "s/PORT_PLACEHOLDER/$APP_PORT/g" /etc/nginx/nginx.conf
else
    sed -i "/PORT_PLACEHOLDER/d" /etc/nginx/nginx.conf
fi

# Start Nginx in background
nginx -g 'daemon on;'

echo "Nginx started successfully..."

STREAM_SOURCE=${STREAM_SOURCE:-"http://stream.radiojar.com/c1wchedg76bwv"}

# Loop ffmpeg indefinitely with 2-minute rolling buffer (30 segments)
while true; do
    echo "[$(date)] Starting FFmpeg HLS transcode from: $STREAM_SOURCE"
    
    ffmpeg -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
        -err_detect ignore_err \
        -i "$STREAM_SOURCE" \
        -c:a aac -b:a 256k -ar 44100 -ac 2 \
        -f hls \
        -hls_time 4 \
        -hls_list_size 30 \
        -hls_flags delete_segments+append_list+omit_endlist \
        -hls_segment_type fmp4 \
        -hls_fmp4_init_filename 'init.mp4' \
        -hls_segment_filename '/var/www/hls/segment_%05d.m4s' \
        /var/www/hls/live.m3u8 || true
        
    echo "[$(date)] FFmpeg exited with code $?, restarting in 2 seconds..."
    sleep 2
done
