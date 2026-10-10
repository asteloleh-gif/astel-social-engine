FROM node:24.20.0-bookworm-slim

# Reproducible Node runtime; avoids a deployment-time mise/GitHub download.
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --omit=dev
COPY --chown=node:node . .
USER node
EXPOSE 8080
CMD ["npm", "start"]
