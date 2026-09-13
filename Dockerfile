# Quick6 FuelHouse — production image
FROM node:22-alpine

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# App code
COPY . .

# Listens inside the container only; the host publishes it on the Docker bridge via compose.
EXPOSE 3300

CMD ["node", "server.js"]
