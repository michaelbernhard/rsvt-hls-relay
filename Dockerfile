FROM alpine:3.19

RUN apk add --no-cache ffmpeg nginx bash curl

RUN mkdir -p /var/www/hls /run/nginx && chmod -R 777 /var/www/hls /run/nginx

COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

CMD ["/entrypoint.sh"]
