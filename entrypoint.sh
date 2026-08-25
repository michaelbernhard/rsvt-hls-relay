#!/bin/bash
set -e

# Start nginx in background
nginx &

echo "Nginx started on port 8080..."

STREAM_SOURCE=${STREAM_SOURCE:-"http://stream.radiojar.com/c1wchedg76bwv"}

# Loop ffmpeg so if Radiojar disconnects, it reconnects automatically
while true; do
    echo "Starting FFmpeg HLS transcode from: $STREAM_SOURCE"
    
    ffmpeg -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
        -err_detect ignore_err \
        -i "$STREAM_SOURCE" \
        -c:a aac -b:a 256k -ar 44100 -ac 2 \
        -f hls \
        -hls_time 4 \
        -hls_list_size 6 \
        -hls_flags delete_segments+append_list+omit_endlist \
        -hls_segment_type aac \
        -hls_segment_filename '/var/www/hls/segment_%05d.aac' \
        /var/www/hls/live.m3u8
        
    echo "FFmpeg exited, restarting in 2 seconds..."
    sleep 2
done
