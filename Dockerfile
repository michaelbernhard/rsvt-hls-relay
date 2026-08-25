FROM alpine:3.19

RUN apk add --no-cache ffmpeg nginx supervisor bash curl

RUN mkdir -p /var/www/hls /run /var/log /etc/supervisor.d && chmod -R 777 /var/www/hls /run

COPY nginx.conf /etc/nginx/nginx.conf
COPY supervisord.conf /etc/supervisord.conf
COPY entrypoint-ffmpeg.sh /entrypoint-ffmpeg.sh
RUN chmod +x /entrypoint-ffmpeg.sh

EXPOSE 8080 80

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]
