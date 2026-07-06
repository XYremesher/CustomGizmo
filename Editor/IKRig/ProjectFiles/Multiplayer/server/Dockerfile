FROM node:22-alpine
EXPOSE 8000
VOLUME [ "/app/data" ]

RUN mkdir /app && chown -R node:node /app
USER node
RUN mkdir /app/client /app/server
WORKDIR /app/server
COPY --chown=node:node debug-certs ./debug-certs/
COPY --chown=node:node package*.json ./
RUN npm install

COPY --chown=node:node server.js ./
CMD [ "node", "uws-server.js" ]
