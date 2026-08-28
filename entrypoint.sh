#!/bin/bash
set -e

APP_PORT="${PORT:-8080}"
echo "Configuring Nginx on port $APP_PORT..."

# Replace port in nginx.conf if assigned dynamically by Railway
sed -i "s/listen 8080/listen $APP_PORT/g" /etc/nginx/nginx.conf
sed -i "s/listen \[::\]:8080/listen \[::\]:$APP_PORT/g" /etc/nginx/nginx.conf

# Prepare in-memory RAM disk directory for HLS
mkdir -p /dev/shm/hls
mkdir -p /var/log/nginx /run

# Function to run continuous FFmpeg HLS transcode with auto-reconnect
start_stream_transcoder() {
    local stream_url="$1"
    local output_dir="$2"
    local prefix="$3"
    local stream_label="$4"

    echo "Starting HLS MPEG-TS packager for $stream_label..."

    while true; do
        ffmpeg -hide_banner -loglevel warning \
            -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 2 \
            -i "$stream_url" \
            -c:a aac -b:a 256k -ar 44100 -ac 2 \
            -f hls \
            -hls_time 2 \
            -hls_list_size 6 \
            -hls_flags delete_segments+append_list+omit_endlist \
            -hls_segment_type mpegts \
            -hls_segment_filename "$output_dir/${prefix}_%05d.ts" \
            "$output_dir/${prefix}.m3u8" || true

        echo "[$stream_label] Transcoder exited. Reconnecting in 1s..."
        sleep 1
    done
}

# Start FFmpeg transcoders in background with unique chunk prefixes in RAM disk
start_stream_transcoder "http://stream.radiojar.com/c1wchedg76bwv" "/dev/shm/hls" "live" "Reservatet.fm LIVE" &
start_stream_transcoder "http://stream.radiojar.com/4hge3m401bpwv" "/dev/shm/hls" "bloede" "Bløde Bølger" &

# Start Nginx in foreground
echo "Starting Nginx web server..."
exec nginx -g "daemon off;"
