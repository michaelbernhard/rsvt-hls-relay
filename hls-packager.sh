#!/bin/bash
set -e

mkdir -p /dev/shm/hls

# Background cleanup: Retain old .ts segments
# - live, bloede & sonos: 10 minutes (600s) on RAM disk
# - timeshift: 195 minutes (3h 15m)
(
    while true; do
        sleep 30
        find /dev/shm/hls -name "live_*.ts" -mmin +10 -delete 2>/dev/null || true
        find /dev/shm/hls -name "bloede_*.ts" -mmin +10 -delete 2>/dev/null || true
        find /dev/shm/hls -name "sonos_*.ts" -mmin +10 -delete 2>/dev/null || true
        find /dev/shm/hls -name "timeshift_*.ts" -mmin +195 -delete 2>/dev/null || true
    done
) &

start_stream_transcoder() {
    local stream_url="$1"
    local output_dir="$2"
    local prefix="$3"
    local stream_label="$4"

    echo "Starting HLS packager for $stream_label (optimized 3s broadcast)..."

    while true; do
        ffmpeg -hide_banner -loglevel warning \
            -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
            -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx \
            -probesize 64k -analyzeduration 500000 \
            -i "$stream_url" \
            -c:a aac -b:a 256k -ar 48000 -ac 2 \
            -f hls \
            -hls_time 3 \
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

start_timeshift_transcoder() {
    local stream_url="$1"
    local output_dir="$2"
    local prefix="timeshift"
    local stream_label="Reservatet.fm 3H Timeshift DVR"

    echo "Starting Timeshift HLS packager for $stream_label (3h rolling buffer, list size 1800)..."

    while true; do
        ffmpeg -hide_banner -loglevel warning \
            -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
            -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx \
            -probesize 64k -analyzeduration 500000 \
            -i "$stream_url" \
            -c:a aac -b:a 256k -ar 48000 -ac 2 \
            -f hls \
            -hls_time 6 \
            -hls_list_size 1800 \
            -hls_delete_threshold 10 \
            -hls_flags append_list+delete_segments+omit_endlist+independent_segments+program_date_time \
            -hls_segment_type mpegts \
            -hls_segment_filename "$output_dir/${prefix}_%d.ts" \
            "$output_dir/${prefix}.m3u8" || true

        echo "[$stream_label] Transcoder disconnected. Auto-recovering in 1s..."
        sleep 1
    done
}

# Sonos-optimeret HLS: 10s segmenter (anbefalet af Sonos docs for Play:3/aeldre hardware)
start_sonos_hls_transcoder() {
    local stream_url="$1"
    local output_dir="$2"
    local prefix="sonos"
    local stream_label="Reservatet.fm Sonos HLS (10s segments)"

    echo "Starting Sonos HLS packager for $stream_label..."

    while true; do
        ffmpeg -hide_banner -loglevel warning \
            -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
            -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx \
            -probesize 64k -analyzeduration 500000 \
            -i "$stream_url" \
            -c:a aac -b:a 256k -ar 48000 -ac 2 \
            -f hls \
            -hls_time 10 \
            -hls_list_size 30 \
            -hls_delete_threshold 15 \
            -hls_flags append_list+delete_segments+omit_endlist \
            -hls_segment_type mpegts \
            -hls_segment_filename "$output_dir/${prefix}_%d.ts" \
            "$output_dir/${prefix}.m3u8" || true

        echo "[$stream_label] Transcoder disconnected. Auto-recovering in 1s..."
        sleep 1
    done
}

start_stream_transcoder "https://cdn01.radio.cloud/RES-COP-CINURAUDIO01" "/dev/shm/hls" "live" "Reservatet.fm LIVE" &
sleep 1
start_stream_transcoder "http://stream.radiojar.com/4hge3m401bpwv" "/dev/shm/hls" "bloede" "Bløde Bølger" &
sleep 1
start_timeshift_transcoder "https://cdn01.radio.cloud/RES-COP-CINURAUDIO01" "/dev/shm/hls" &
sleep 1
start_sonos_hls_transcoder "https://cdn01.radio.cloud/RES-COP-CINURAUDIO01" "/dev/shm/hls" &

wait
