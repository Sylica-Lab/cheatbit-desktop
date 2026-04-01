# Sylica AI Mobile

Android-first Expo companion app for Sylica AI.

## What v1 includes

- email sign in / registration
- secure local session storage
- account dashboard and billing links
- general chat threads backed by the existing Sylica backend
- QR-based phone pairing with the desktop dashboard
- phone relay actions for clipboard text, OTP codes, links, and notes

## Required backend env

- `BACKEND_TOKEN_SECRET`
- `DATABASE_URL`
- `TOGETHER_API_KEY`
- optional: `MOBILE_CHAT_MODEL`

## Local run

```bash
npm run mobile:start
```

To point the app at a different backend:

```bash
EXPO_PUBLIC_SYLICA_BACKEND_URL=https://cheat.trybookai.com npm run mobile:start
```

## Notes

- The mobile app uses `POST /api/mobile/chat/respond` for chat replies.
- Desktop relay pairing uses `/api/phone/pairing-sessions`, `/api/phone/devices`, and `/api/phone/events`.
- Passive Android notification capture, share-intents, and phone-call audio ingestion are not in this first mobile relay pass.
