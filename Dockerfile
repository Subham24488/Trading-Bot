FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY prisma ./prisma
RUN pnpm db:generate
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --prod --frozen-lockfile
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]
