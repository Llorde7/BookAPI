# BookAPI

Booking API built with TypeScript, Express and PostgreSQL.

## Setup

```sh
cp .env.example .env
npm install
npm run db:up   # starts PostgreSQL via docker compose
npm run dev     # http://localhost:3000/health
```

## Scripts

| Script                            | Purpose                 |
| --------------------------------- | ----------------------- |
| `npm run dev`                     | Run with reload (tsx)   |
| `npm run build` / `npm start`     | Compile to `dist/`, run |
| `npm run typecheck`               | Type-check only         |
| `npm run lint` / `lint:fix`       | ESLint                  |
| `npm run format` / `format:check` | Prettier                |
| `npm run db:up` / `db:down`       | Start / stop PostgreSQL |
