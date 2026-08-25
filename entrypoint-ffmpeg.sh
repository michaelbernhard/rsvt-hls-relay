#!/bin/bash
STREAM_SOURCE=${STREAM_SOURCE:-"http://stream.radiojar.com/c1wchedg76bwv"}

# Prune old segments from disk every 30 seconds to keep disk usage under 5MB forever
(
    while true; do
        sleep 30
        find /var/www/hls -name "segment_*.m4s" -mmin +2 -delete 2>/dev/null || true
    done
) &

echo "Starting FFmpeg HLS transcode from: $STREAM_SOURCE"
exec ffmpeg -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
    -err_detect ignore_err \
    -i "$STREAM_SOURCE" \
    -c:a aac -b:a 256k -ar 44100 -ac 2 \
    -f hls \
    -hls_time 4 \
    -hls_list_size 10 \
    -hls_flags delete_segments+append_list+omit_endlist+independent_segments \
    -hls_segment_type fmp4 \
    -hls_fmp4_init_filename 'init.mp4' \
    -hls_segment_filename '/var/www/hls/segment_%05d.m4s' \
    /var/www/hls/live.m3u8
