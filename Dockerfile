# mcp-personal-suite — local HTTP transport container
#
# Build:  docker build -t personal-suite .
# Run:    docker run -d --network host \
#           -v $HOME/.personal-suite:/root/.personal-suite \
#           -e MCP_HTTP=1 -e MCP_PORT=5120 \
#           personal-suite

FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

ENV MCP_HTTP=1
ENV MCP_PORT=5120
ENV MCP_HOST=0.0.0.0

EXPOSE 5120

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||5120)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/server.js"]
