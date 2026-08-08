<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="resources/images/LandtakerLogoDark.svg">
    <source media="(prefers-color-scheme: light)" srcset="resources/images/LandtakerLogo.svg">
    <img src="resources/images/LandtakerLogo.svg" alt="Landtaker Logo" width="300">
  </picture>
</p>

Landtaker is an online real-time strategy game focused on territorial control and alliance building. Players compete to expand their territory, build structures, and form strategic alliances in various maps based on real-world geography.

Landtaker is a fork of [OpenFront.io](https://openfront.io/), which is itself a fork/rewrite of WarFront.io. Credit to https://github.com/openfrontio/OpenFrontIO and https://github.com/WarFrontIO. This project is not affiliated with or endorsed by OpenFront Inc.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Assets: CC BY-SA 4.0](https://img.shields.io/badge/Assets-CC%20BY--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-sa/4.0/)

## License

Source code is licensed under the **GNU Affero General Public License v3.0**.
Running a modified version as a network service obliges you to offer its
source — this repository is that offer.

Assets under `/resources` are CC BY-SA 4.0 and **require attribution to
"OpenFront" or "OpenFront Inc."** (see [LICENSE-ASSETS](LICENSE-ASSETS)). The
game ships a large amount of that art, so the credit is carried in the footer:

- Footer: "© Landtaker · built on OpenFront™ and Contributors"

Keep that line, or replace the CC BY-SA assets first. See the
[LICENSE](LICENSE) for the code's complete requirements.

For asset licensing, see [LICENSE-ASSETS](LICENSE-ASSETS).  
For license history, see [LICENSING.md](LICENSING.md).

## 💬 Community

- Discord: https://discord.gg/FztuCAcVGD
- Reddit: https://www.reddit.com/r/landtaker/

## 🌟 Features

- **Real-time Strategy Gameplay**: Expand your territory and engage in strategic battles
- **Alliance System**: Form alliances with other players for mutual defense
- **Multiple Maps**: Play across various geographical regions including Europe, Asia, Africa, and more
- **Resource Management**: Balance your expansion with defensive capabilities
- **Cross-platform**: Play in any modern web browser

## 📋 Prerequisites

- [npm](https://www.npmjs.com/) (v10.9.2 or higher)
- A modern web browser (Chrome, Firefox, Edge, etc.)

## 🚀 Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/beitechnikfragen/landtaker.git
   cd landtaker
   ```

2. **Install dependencies**

   ```bash
   npm run inst
   ```

   Do NOT use `npm install` nor `npm i` but instead use our `npm run inst`. It runs the safer `npm ci --ignore-scripts` to install dependencies exactly according to the versions in `package-lock.json` and doesn't run scripts. This can prevent being hit by a supply chain attack.

## 🎮 Running the Game

### Development Mode

Run both the client and server in development mode with live reloading:

```bash
npm run dev
```

This will:

- Start the webpack dev server for the client
- Launch the game server with development settings
- Open the game in your default browser (to disable this behavior, set `SKIP_BROWSER_OPEN=true` in your environment)

### Client Only

To run just the client with hot reloading:

```bash
npm run start:client
```

### Server Only

To run just the server with development settings:

```bash
npm run start:server-dev
```

### Connecting to staging or production backends

Sometimes it's useful to connect to production servers when replaying a game, testing user profiles, purchases, or login flow.

> To replay a production game, make sure you're on the same commit that the game you want to replay was executed on, you can find the `gitCommit` value via `https://api.landtaker.io/game/[gameId]`.
> Unfinished games cannot be replayed on localhost.

To connect to staging api servers:

```bash
npm run dev:staging
```

To connect to production api servers:

```bash
npm run dev:prod
```

## 🛠️ Development Tools

- **Format code**:

  ```bash
  npm run format
  ```

- **Lint code with Oxlint and ESLint**:

  ```bash
  npm run lint
  ```

- **Lint and fix code with Oxlint and ESLint**:

  ```bash
  npm run lint:fix
  ```

- **Testing**
  ```bash
  npm test
  ```

## 🏗️ Project Structure

- `/src/client` - Frontend game client
- `/src/core` - Deterministic game simulation
- `/src/server` - Backend game server (lobbies, match relay)
- `/backend` - Our own API: accounts, ranked, friends, parties (Fastify + Postgres)
- `/resources` - Upstream static assets (images, maps, sounds) — CC BY-SA 4.0
- `/brand` - Landtaker marks, rank insignia and fonts — see `brand/LICENSE`

## 🤝 Contributing

Landtaker is **not accepting external contributions** at the moment. Bugs and
ideas are very welcome through the in-game feedback button (bottom-left) or on
[Discord](https://discord.gg/FztuCAcVGD). See [CONTRIBUTING.md](CONTRIBUTING.md).
