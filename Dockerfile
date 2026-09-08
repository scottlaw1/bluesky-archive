FROM node:20-slim

# better-sqlite3 compiles a native addon at install time
RUN apt-get update && apt-get install -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# We're running via tsx directly rather tha building to dist/,
# which keeps this Dockerfile simple and matches how you've been running it locally.
CMD ["npx","tsx", "src/pipeline/schedule.ts"]
