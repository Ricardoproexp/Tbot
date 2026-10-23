FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY index.js plisio.cjs config.cjs discord-journal.cjs ./
ENV PORT=3001
EXPOSE 3001
CMD ["node", "index.js"]
