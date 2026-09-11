#!/bin/bash
# Reservatet.fm - Dedicated 192k MP3 Broadcast Stream for Sonos
# Re-clocked with aresample=async=1000 to completely eliminate clock drift on Sonos hardware

echo "[Sonos Broadcaster] Starting clean 192k continuous MP3 stream with drift correction..."

while true; do
    ffmpeg -hide_banner -loglevel warning         -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5         -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx         -i "http://127.0.0.1:8000/live.mp3"         -af "aresample=async=1000"         -vn         -c:a libmp3lame         -b:a 192k         -ar 48000         -ac 2         -content_type audio/mpeg         -f mp3         icecast://source:rsvt_source_secret_2026@127.0.0.1:8000/sonos.mp3 || true

    echo "[Sonos Broadcaster] Stream disconnected. Auto-recovering in 1s..."
    sleep 1
done
