FROM alpine:3.19

RUN apk add --no-cache nginx ffmpeg bash curl nodejs

COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
COPY audio-proxy.js /audio-proxy.js
COPY stats-server.js /stats-server.js
RUN chmod +x /entrypoint.sh

EXPOSE 8080

CMD ["/entrypoint.sh"]
