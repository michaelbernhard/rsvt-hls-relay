FROM alpine:3.19

RUN apk add --no-cache nginx ffmpeg bash curl nodejs

COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
COPY audio-proxy.js /audio-proxy.js
COPY stats-server.js /stats-server.js
RUN chmod +x /entrypoint.sh

# Build-time validation: ensures any syntax error fails the build before deployment
RUN mkdir -p /dev/shm /var/log/nginx /run && \
    nginx -t && \
    node --check /audio-proxy.js && \
    node --check /stats-server.js

EXPOSE 8080

CMD ["/entrypoint.sh"]
