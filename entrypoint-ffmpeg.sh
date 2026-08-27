#!/bin/bash
STREAM_SOURCE=${STREAM_SOURCE:-"http://stream.radiojar.com/c1wchedg76bwv"}

# Use Linux shared memory RAM disk (/dev/shm) for ultra-fast, zero-latency chunk I/O
mkdir -p /dev/shm/hls
rm -rf /var/www/hls
ln -s /dev/shm/hls /var/www/hls

# Prune old segments from RAM disk every 20 seconds to keep memory footprint under 5MB forever
(
    while true; do
        sleep 20
        find /dev/shm/hls -name "segment_*.m4s" -mmin +2 -delete 2>/dev/null || true
    done
) &

echo "Starting optimized low-jitter FFmpeg HLS transcode from: $STREAM_SOURCE"
exec ffmpeg -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 2 \
    -err_detect ignore_err \
    -fflags +genpts+nobuffer+flush_packets \
    -probesize 32768 -analyzeduration 0 \
    -i "$STREAM_SOURCE" \
    -af "aresample=async=1000:min_hard_comp=0.100000:first_pts=0" \
    -c:a aac -b:a 256k -ar 44100 -ac 2 \
    -flags +global_header \
    -avoid_negative_ts make_zero \
    -f hls \
    -hls_time 4 \
    -hls_list_size 12 \
    -hls_flags delete_segments+append_list+omit_endlist+independent_segments+temp_file \
    -hls_segment_type fmp4 \
    -hls_fmp4_init_filename 'init.mp4' \
    -hls_segment_filename '/var/www/hls/segment_%05d.m4s' \
    /var/www/hls/live.m3u8
