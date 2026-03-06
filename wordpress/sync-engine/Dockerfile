FROM node:18-alpine

# Install curl for the healthcheck
RUN apk add --no-cache curl

WORKDIR /usr/src/app

# Install dependencies using the lockfile for reproducible builds
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD pgrep -f "node index.js" || exit 1

CMD ["node", "index.js"]
