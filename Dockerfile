FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787
ENV AI_IMAGE_LOG_DIR=/app/logs

COPY outputs ./outputs
RUN mkdir -p /app/logs && chown -R node:node /app/logs

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER node

CMD ["node", "outputs/ai-image-proxy-server.mjs"]
