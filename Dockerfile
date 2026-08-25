FROM alpine:3.19

RUN apk add --no-cache ffmpeg nginx bash curl

# Create HLS directory
RUN mkdir -p /var/www/hls && chown -R nginx:nginx /var/www/hls

COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

CMD ["/entrypoint.sh"]
