#!/bin/bash
STREAM_SOURCE=${STREAM_SOURCE:-"http://stream.radiojar.com/c1wchedg76bwv"}

# Use Linux shared memory RAM disk (/dev/shm) for ultra-fast, zero-latency chunk I/O
mkdir -p /dev/shm/hls
rm -rf /var/www/hls
ln -s /dev/shm/hls /var/www/hls

# Prune old segments from RAM disk only after 6 minutes (prevents any Sonos 404 underruns)
(
    while true; do
        sleep 30
        find /dev/shm/hls -name "segment_*.m4s" -mmin +6 -delete 2>/dev/null || true
    done
) &

echo "Starting optimized rock-solid FFmpeg HLS transcode with ICY metadata from: $STREAM_SOURCE"
exec ffmpeg -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 2 \
    -err_detect ignore_err \
    -fflags +genpts+nobuffer+flush_packets+discardcorrupt \
    -probesize 32768 -analyzeduration 0 \
    -icy 1 \
    -i "$STREAM_SOURCE" \
    -map_metadata 0 \
    -af "aresample=async=1000:min_hard_comp=0.010000:first_pts=0" \
    -c:a aac -b:a 256k -ar 44100 -ac 2 \
    -flags +global_header \
    -avoid_negative_ts make_zero \
    -f hls \
    -hls_time 4 \
    -hls_list_size 20 \
    -hls_flags append_list+omit_endlist+independent_segments+temp_file+program_date_time \
    -hls_segment_type fmp4 \
    -hls_fmp4_init_filename 'init.mp4' \
    -hls_segment_filename '/var/www/hls/segment_%05d.m4s' \
    /var/www/hls/live.m3u8
