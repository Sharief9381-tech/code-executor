# CodeHiring Execution Engine
# Deploys to Render.com free tier
FROM docker:24-dind-rootless

USER root

# Install Node.js 20
RUN apk add --no-cache nodejs npm curl bash

WORKDIR /app
COPY package.json .
COPY server.mjs .

EXPOSE 4000

# Start dockerd + executor together
CMD ["sh", "-c", "dockerd-entrypoint.sh & sleep 3 && node server.mjs"]
