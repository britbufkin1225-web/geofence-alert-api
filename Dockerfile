FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# Prisma 7 does not generate the client on install, and the container's
# node_modules is an anonymous volume rather than the host's, so the client has
# to be generated here or `start:dev` fails on first boot. Generation reads the
# schema only — no database connection is required at build time.
RUN npx prisma generate

EXPOSE 3000

CMD ["npm", "run", "start:dev"]
