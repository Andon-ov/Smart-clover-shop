FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

# Wait-for-it pattern to ensure DBs are ready could be added here
CMD ["node", "index.js"]
