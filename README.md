# AI-CHAT

AI-CHAT is a Next.js frontend for a chat app that connects to a local backend over HTTP and WebSocket.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a frontend environment file if needed:

```bash
cp .env.local.example .env.local
```

3. Set the backend URL used by the login flow:

```bash
NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8000
```

## Run

Start the development server:

```bash
npm run dev
```

The app runs at `http://localhost:3000` by default.

## Scripts

```bash
npm run dev
npm run build
npm run lint
```

## Notes

- The frontend expects the backend API and WebSocket server on `http://127.0.0.1:8000`.
- Login redirects through the backend OAuth flow.
- Chat history, user stats, and conversation management are all backed by the API.
