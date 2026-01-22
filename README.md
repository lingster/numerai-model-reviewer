# NMR - Numerai Model Reviewer

A SvelteKit web application for comparing and analyzing the performance of Numerai tournament models. Features a distinctive retro 80's aesthetic.

## Features

- **Model Search & Comparison**: Search for Numerai users and their trading models, compare performance metrics side-by-side
- **Performance Visualization**: Bar charts comparing Corr20 and MMC metrics across selected models
- **Detailed Metrics Table**: View latest performance data including Correlation, MMC, FNC, Stake Value, and Correlation Multiplier
- **Shareable Configurations**: Save and share model comparison configurations via URLs
- **Cross-User Comparison**: Compare models across different Numerai users
- **Custom Date Ranges**: Select specific time periods for analysis (defaults to last 30 days)

## Tech Stack

- **SvelteKit 2** - Full-stack framework with file-based routing
- **Svelte 5** - Component framework with runes API (`$props()`, `$state()`)
- **TypeScript** - Type safety throughout
- **Tailwind CSS 4** - Utility-first CSS via Vite plugin
- **Vite** - Build tool and development server
- **Vitest** - Unit testing
- **Playwright** - E2E testing

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
npm install
```

### Development

Start the development server:

```bash
npm run dev

# Or open in browser automatically
npm run dev -- --open
```

### Building

Create a production build:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |
| `npm run check` | TypeScript type checking |
| `npm run check:watch` | Type checking (watch mode) |
| `npm run lint` | Run ESLint |
| `npm run format` | Format code with Prettier |
| `npm run test` | Run all tests |
| `npm run test:unit` | Run unit tests |
| `npm run test:e2e` | Run E2E tests |

## Project Structure

```
src/
├── routes/
│   ├── +layout.svelte    # App layout with navigation
│   ├── +page.svelte      # Landing page
│   └── models/
│       └── +page.svelte  # Model comparison interface
├── lib/
│   ├── components/       # Reusable Svelte components
│   ├── services/         # API clients and business logic
│   ├── stores/           # Svelte stores for state management
│   └── types/            # TypeScript type definitions
├── app.html              # Root HTML template
└── app.css               # Global styles
static/                   # Static assets
```

## Key Metrics

The application tracks and displays:

- **Corr20** - 20-day rolling correlation
- **MMC** - Model Meta Correlation (contribution beyond benchmark)
- **FNC** - Feature Neutral Correlation
- **Stake Value** - Amount staked on the model
- **Correlation Multiplier** - Payout multiplier based on performance

## Design

Features a retro 80's/16-bit gaming aesthetic:
- Dark background with crimson accents
- Monospace typography
- Pixelated effects and geometric shadows
- Color-coded metrics (green/red for positive/negative values)

## API Integration

Integrates with the Numerai API to fetch:
- User information and leaderboard data
- Model details and metadata
- Historical performance metrics

Supports optional API credentials for enhanced data access with fallback to public data.

## License

Private - Numerai Tournament Tools
