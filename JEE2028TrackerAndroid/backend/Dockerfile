FROM node:22-alpine
WORKDIR /srv/jee-api
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATA_FILE=/data/store.json
COPY --chown=node:node server.js ./server.js
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
