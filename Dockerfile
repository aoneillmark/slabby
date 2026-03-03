# Slabby HTTP Server - Dockerfile for Google Cloud Run
# 
# This builds a READ-ONLY MCP server for Slab knowledge base access.
# Update/delete operations are disabled for security.

FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --production=false

# Copy source code
COPY . .

# Build TypeScript
RUN npx tsc --outDir dist --esModuleInterop --module NodeNext --moduleResolution NodeNext --target ES2022

# Cloud Run uses PORT env var (default 8080)
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

# Health check for Cloud Run
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Run the HTTP server
CMD ["node", "--experimental-specifier-resolution=node", "dist/src/server-http.js"]
