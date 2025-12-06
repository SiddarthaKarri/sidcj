FROM node:20-slim

# Install compilers and runtimes
RUN apt-get update && apt-get install -y \
    g++ \
    make \
    python3 \
    openjdk-17-jdk-headless \
    nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production

COPY . .

ENV PORT=8000
EXPOSE 8000

CMD ["npm", "start"]
