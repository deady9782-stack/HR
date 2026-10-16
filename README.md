# HR Operations

A Discord roleplay community HR starter project. It includes a browser-based employee portal prototype and a Discord bot for department interviews, offers, Discord role assignment, employee records, shift logging, FTO requests, and HR actions.

## Requirements

- Node.js 20 or newer and npm
- A Discord application and bot with the `applications.commands` and `bot` scopes
- Bot permissions to manage roles (the bot's highest role must be above the department roles)

## Run the portal

```powershell
npm install
```

Copy `.env.example` to `.env` and set a long, private `BOOTSTRAP_HR_CODE`. Start `npm run api` and `npm run dev` in separate terminals, then open Vite's local URL. Create the first HR account using the bootstrap code; later Staff and HR access requests require HR approval. Passwords are scrypt-hashed and sessions use HTTP-only cookies.

The browser demo personnel and shift records remain in local storage and are not connected to the bot's JSON store or protected as authoritative HR data. Use fictional data only until shared database-backed personnel APIs are added.

## Configure and run the bot

Copy `.env.example` to `.env`, fill in the Discord application values, and configure the role IDs. Keep `.env` private and never commit bot tokens.

```powershell
npm run register
npm run bot
```

`register` publishes guild-scoped slash commands. The bot persists records in `data.json` beside `bot.js`. Back up that file. For a deployed multi-server system, replace the local JSON store with a database and add Discord OAuth2 authentication and role-gated portal APIs before exposing personnel data publicly.

## Commands

- `/interview department:<department>` starts a structured interview. Police, Fire, EMS, and DOT have no RP-day minimum; all other departments require 14 days.
- `/portal` returns a private button to open the employee and HR portal.

All non-interview work is done in the portal: employee clock-in/out, shift notes, directory, FTO requests, staff interviews, HR reviews, and promotion tracking. Set `PORTAL_URL` in `.env` to a site accessible to your players. `http://localhost:5173` is only useful for testing on the computer running Vite; Discord users on other computers need a deployed HTTPS URL.

## Gemini interview decisions

Set `GEMINI_API_KEY` in `.env` with a Google AI Studio key. The bot uses the official `@google/genai` SDK and defaults to `gemini-flash-latest`. Gemini evaluates answer quality and returns structured feedback; RP-day minimums are checked in code first. AI outages queue the application for HR review. Staff access always needs a final HR approval in the portal.

## Editable rank defaults

- Police: Probationary Cadet, Cadet, Police Officer I/II/III, Senior Officer, Corporal, Sergeant, Lieutenant, Captain, Deputy Chief, Chief of Police.
- Fire: Probationary Fire Cadet, Fire Cadet, Firefighter I/II/III, Engineer, Lieutenant, Captain, Battalion Chief, Deputy Chief, Fire Chief.
- EMS: Probationary EMT Trainee, EMT Trainee, EMT, Advanced EMT, Paramedic, Field Supervisor, Lieutenant, Captain, Deputy Chief, EMS Chief.
- DOT: Probationary Traffic Officer, Traffic Officer I/II/III, Senior Traffic Officer, Supervisor, Area Supervisor, Deputy Director, Director.
- Dispatcher, Judge, K9, Traffic Enforcement, CSI, and SWAT have starter ladders in `bot.js`.

These are editable examples, not a universal real-world standard. Configure rank Discord roles with `RANK_ROLE_<DEPARTMENT>_<RANK>` variables in `.env` when you want the bot to update Discord rank roles on promotion.

## Important scope notes

The bot uses Gemini for structured pass/fail recommendations and constructive interview feedback. Applicant answers are sent to Google's Gemini API; do not ask applicants to include real-world sensitive personal data. RP-day requirements remain deterministic, and AI outages go to HR review instead of rejection. Staff access always requires HR approval. Gemini evaluates roleplay answers only, not real-world employment qualifications. Rank ladders and callsign prefixes are editable agency examples. Portal personnel data currently remains browser-local and is not connected to the bot JSON store. Do not enter real employee signatures or sensitive records until a shared secure database, authorization, and retention controls are implemented.
