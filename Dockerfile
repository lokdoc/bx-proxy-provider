FROM oven/bun:1.2.2


WORKDIR /app

COPY package.json .

RUN bun install

COPY src/ ./src/

CMD ["bun", "src/index.js"]
