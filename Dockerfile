# WeavrNet — self-hosted relay for Weavr
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=7780 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 7780

# No HEALTHCHECK on purpose: Traefik stops routing to a container until its
# health check passes, so after every restart WeavrNet answered 404 for a
# while (and for good if the check ever failed). GET /api/health is there
# for anyone who wants to add one in their own compose file.

CMD ["node", "src/index.js"]
