FROM node:18-alpine

WORKDIR /app

# Install build tools
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN npm install

# Copy source
COPY src ./src
COPY tsconfig.json ./

# Build
RUN npm run build

# Runtime environment
ENV NODE_ENV=production

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

USER nodejs

# Run bot
ENTRYPOINT ["node", "dist/main.js"]
