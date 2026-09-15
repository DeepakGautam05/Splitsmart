# SplitSmart

A split-bill calculator for groups — add members, log expenses with equal,
custom-amount, percentage, or shares-based splits, and get the minimum
number of payments needed to settle everyone up. Includes a shareable JPEG
summary, a WhatsApp-style copy message, and per-person breakdowns.

Everything runs client-side; expenses are saved to `localStorage` so past
splits persist between visits, and nothing is sent to a server.

## Run locally

```bash
npm install
npm run dev
```

## Build for production

```bash
npm run build
npm run preview
```

## Stack

React + Vite, [lucide-react](https://lucide.dev/) for icons. All monetary
math is done in integer paise (never floating point) with a carry-forward
rounding scheme so per-person totals stay fair even when an amount doesn't
divide evenly among participants.
