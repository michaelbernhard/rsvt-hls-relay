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

# Sonos-optimeret HLS: 10s segmenter med 60s forsinket playliste (sikrer altid 60-90s faerdig buffer)
start_sonos_hls_transcoder() {
    local stream_url="$1"
    local output_dir="$2"
    local prefix="sonos"
    local stream_label="Reservatet.fm Sonos HLS (10s segments + 60s ring buffer)"

    echo "Starting Sonos HLS packager for $stream_label..."

    # Seed sonos_raw.m3u8 from existing sonos.m3u8 to prevent any cold-start gaps
    if [ -f "$output_dir/${prefix}.m3u8" ] && [ ! -f "$output_dir/${prefix}_raw.m3u8" ]; then
        cp "$output_dir/${prefix}.m3u8" "$output_dir/${prefix}_raw.m3u8"
    fi

    # Start background playlist pacer that keeps sonos.m3u8 delayed by 6 segments (60s)
    # This guarantees Sonos always requests segments that are already 100% written on the RAM disk,
    # eliminating clock drift underruns and song-transition dropouts completely.
    python3 -u -c '
import os, sys, time

raw_pl = sys.argv[1]
target_pl = sys.argv[2]
tmp_pl = target_pl + ".tmp"
delay_segs = int(sys.argv[3])

last_content = ""

while True:
    try:
        if os.path.exists(raw_pl):
            with open(raw_pl, "r") as f:
                content = f.read()
            if content and content != last_content:
                lines = content.splitlines()
                header = []
                segments = []
                current_seg = []
                for line in lines:
                    if line.startswith("#EXTINF") or (current_seg and not line.startswith("#")):
                        current_seg.append(line)
                        if len(current_seg) == 2:
                            segments.append(current_seg)
                            current_seg = []
                    elif not segments:
                        header.append(line)
                
                if len(segments) > delay_segs:
                    delayed_segs = segments[:-delay_segs]
                else:
                    delayed_segs = segments
                
                out_lines = header[:]
                for seg in delayed_segs:
                    out_lines.extend(seg)
                out_content = "\n".join(out_lines) + "\n"
                
                with open(tmp_pl, "w") as f:
                    f.write(out_content)
                os.replace(tmp_pl, target_pl)
                last_content = content
    except Exception as e:
        pass
    time.sleep(1)
' "$output_dir/${prefix}_raw.m3u8" "$output_dir/${prefix}.m3u8" 6 &

    while true; do
        ffmpeg -hide_banner -loglevel warning \
            -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
            -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx \
            -probesize 64k -analyzeduration 500000 \
            -i "$stream_url" \
            -c:a aac -b:a 256k -ar 48000 -ac 2 \
            -f hls \
            -hls_time 10 \
            -hls_list_size 36 \
            -hls_delete_threshold 24 \
            -hls_flags append_list+delete_segments+omit_endlist+temp_file \
            -hls_segment_type mpegts \
            -hls_segment_filename "$output_dir/${prefix}_%d.ts" \
            "$output_dir/${prefix}_raw.m3u8" || true

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
