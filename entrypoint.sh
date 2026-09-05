#!/bin/bash
set -e

APP_PORT="${PORT:-8080}"
echo "Configuring Nginx on port $APP_PORT..."

# Replace port in nginx.conf if assigned dynamically by Railway
sed -i "s/listen 8080/listen $APP_PORT/g" /etc/nginx/nginx.conf
sed -i "s/listen \[::\]:8080/listen \[::\]:$APP_PORT/g" /etc/nginx/nginx.conf
nginx -t

# Prepare in-memory RAM disk directory for HLS
mkdir -p /dev/shm/hls
mkdir -p /var/log/nginx /run

# Background cleanup: Retain old .ts segments for 10 minutes (600s) on RAM disk
# This eliminates all 404 underruns for Sonos speakers and multiroom setups
(
    while true; do
        sleep 30
        find /dev/shm/hls -name "*.ts" -mmin +10 -delete 2>/dev/null || true
    done
) &

# Function to run continuous FFmpeg HLS transcode (broadcast standard)
# Key fixes:
#   - Continuous monotonic sequence numbering (eliminates epoch jumps that cause iOS/Sonos drops)
#   - Robust reconnect flags (-reconnect_on_network_error, -reconnect_on_http_error)
#   - delete_segments + append_list + omit_endlist for stable live rolling buffer
start_stream_transcoder() {
    local stream_url="$1"
    local output_dir="$2"
    local prefix="$3"
    local stream_label="$4"

    echo "Starting HLS packager for $stream_label (broadcast standard)..."

    while true; do
        ffmpeg -hide_banner -loglevel warning \
            -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
            -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx \
            -probesize 64k -analyzeduration 500000 \
            -i "$stream_url" \
            -c:a aac -b:a 256k -ar 48000 -ac 2 \
            -f hls \
            -hls_time 6 \
            -hls_list_size 20 \
            -hls_delete_threshold 5 \
            -hls_flags append_list+delete_segments+omit_endlist+independent_segments \
            -hls_segment_type mpegts \
            -hls_segment_filename "$output_dir/${prefix}_%d.ts" \
            "$output_dir/${prefix}.m3u8" || true

        echo "[$stream_label] Transcoder disconnected. Auto-recovering in 1s..."
        sleep 1
    done
}

# Start Direct MP3 Audio Proxy in background (port 8082)
echo "Starting Node.js Direct MP3 Audio Proxy..."
node /audio-proxy.js &

# Start Stats Server in background (port 8081)
echo "Starting Stats Server..."
node /stats-server.js &

# Start FFmpeg transcoders in background
start_stream_transcoder "https://cdn01.radio.cloud/RES-COP-CINURAUDIO01" "/dev/shm/hls" "live" "Reservatet.fm LIVE" &
start_stream_transcoder "http://stream.radiojar.com/4hge3m401bpwv" "/dev/shm/hls" "bloede" "Bløde Bølger" &

# Start Nginx in foreground
echo "Starting Nginx web server..."
exec nginx -g "daemon off;"
