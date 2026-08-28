FROM alpine:3.19

RUN apk add --no-cache icecast nodejs bash curl

RUN mkdir -p /var/log/icecast /etc/icecast2 && \
    chown -R icecast:icecast /var/log/icecast

COPY icecast.xml /etc/icecast2/icecast.xml
COPY stream-feeder.js /stream-feeder.js
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

CMD ["/entrypoint.sh"]
