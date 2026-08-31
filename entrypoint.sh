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

# Background cleanup: Retain old .ts segments for 10 minutes (600s) on RAM disk
# This eliminates all 404 underruns for Sonos speakers and multiroom setups
(
    while true; do
        sleep 30
        find /dev/shm/hls -name "*.ts" -mmin +10 -delete 2>/dev/null || true
    done
) &

# Function to run continuous FFmpeg HLS transcode matching BBC Audio Factory standard (6s chunks, 20 chunks = 120s buffer window)
start_stream_transcoder() {
    local stream_url="$1"
    local output_dir="$2"
    local prefix="$3"
    local stream_label="$4"

    echo "Starting broadcast-grade HLS packager for $stream_label (6s chunks, 120s buffer window, 10min retention)..."

    while true; do
        ffmpeg -hide_banner -loglevel warning \
            -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 2 \
            -probesize 64k -analyzeduration 500000 \
            -i "$stream_url" \
            -af "aresample=async=1000:first_pts=0" \
            -c:a aac -b:a 256k -ar 44100 -ac 2 \
            -f hls \
            -hls_time 6 \
            -hls_list_size 20 \
            -hls_flags append_list+omit_endlist+temp_file \
            -hls_segment_type mpegts \
            -hls_segment_filename "$output_dir/${prefix}_%05d.ts" \
            "$output_dir/${prefix}.m3u8" || true

        echo "[$stream_label] Transcoder disconnected. Auto-recovering in 1s..."
        sleep 1
    done
}

# Start FFmpeg transcoders in background
start_stream_transcoder "http://stream.radiojar.com/c1wchedg76bwv" "/dev/shm/hls" "live" "Reservatet.fm LIVE" &
start_stream_transcoder "http://stream.radiojar.com/4hge3m401bpwv" "/dev/shm/hls" "bloede" "Bløde Bølger" &

# Start Nginx in foreground
echo "Starting Nginx web server..."
exec nginx -g "daemon off;"
