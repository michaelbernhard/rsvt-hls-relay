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
            -hls_flags append_list+delete_segments+omit_endlist+independent_segments+temp_file \
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
            -hls_flags append_list+delete_segments+omit_endlist+independent_segments+program_date_time+temp_file \
            -hls_segment_type mpegts \
            -hls_segment_filename "$output_dir/${prefix}_%d.ts" \
            "$output_dir/${prefix}.m3u8" || true

        echo "[$stream_label] Transcoder disconnected. Auto-recovering in 1s..."
        sleep 1
    done
}

# Sonos-optimeret HLS: 9.6s frame-aligned segmenter, 60-segment vindue (9.6 min buffer)
# INGEN pacer – lang playliste + perfekt AAC frame alignment eliminerer drift.
# 9.6s = præcis 450 AAC frames ved 48kHz (450 × 1024/48000 = 9.600000s) → nul afrundingsfejl.
start_sonos_hls_transcoder() {
    local stream_url="$1"
    local output_dir="$2"
    local prefix="sonos"
    local stream_label="Reservatet.fm Sonos HLS (9.6s frame-aligned, 60-seg window)"

    echo "Starting Sonos HLS packager for $stream_label..."

    # Clean up any leftover raw playlist from the old pacer
    rm -f "$output_dir/${prefix}_raw.m3u8" "$output_dir/${prefix}_raw.m3u8.tmp"

    while true; do
        ffmpeg -hide_banner -loglevel warning \
            -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
            -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx \
            -probesize 64k -analyzeduration 500000 \
            -i "$stream_url" \
            -c:a aac -b:a 256k -ar 48000 -ac 2 \
            -f hls \
            -hls_time 9.6 \
            -hls_list_size 60 \
            -hls_delete_threshold 40 \
            -hls_flags append_list+delete_segments+omit_endlist+temp_file \
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
