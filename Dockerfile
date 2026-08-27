FROM alpine:3.19

RUN apk add --no-cache ffmpeg nginx supervisor bash curl nodejs

RUN mkdir -p /var/www/hls /run /var/log /etc/supervisor.d && chmod -R 777 /var/www/hls /run

COPY nginx.conf /etc/nginx/nginx.conf
COPY supervisord.conf /etc/supervisord.conf
COPY entrypoint-ffmpeg.sh /entrypoint-ffmpeg.sh
COPY stats-server.js /stats-server.js
COPY start-nginx.sh /start-nginx.sh
RUN chmod +x /entrypoint-ffmpeg.sh /start-nginx.sh

EXPOSE 8080 80

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]
