FROM node:22-alpine
WORKDIR /app
COPY package.json build.js ./
COPY src ./src
COPY server ./server
RUN node build.js && mkdir /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=3000 PARLEY_DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "server/index.js"]
