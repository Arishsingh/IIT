# IIT Professor Finder

A desktop app for finding research-internship contacts. Type a city ("Mumbai", "Chennai", "Jammu"…), and it lists the professors in that IIT's tech departments (CS, EE/ECE, AI, Data Science) with their **email**, research areas, homepage, Google Scholar link and a LinkedIn people-search link. Filter by research keyword or department, click an email to copy it, and export the list to CSV.

![stack](https://img.shields.io/badge/Electron-React%20%2B%20Vite-blue)

## Setup

Requires Node.js 20+.

```bash
npm install
```

## Run

```bash
npm start          # build the UI and open the desktop app
npm run dev        # development mode with hot reload (Vite + Electron)
```

## Emailing professors ("Email them")

The sidebar has two sections: **Contacts** (find professors) and **Email them** (send each one a personal email).

1. **Account.** Enter your name, email address and password. For Gmail this must be an
   [App Password](https://myaccount.google.com/apppasswords) (turn on 2-Step Verification first), not your normal password.
   Outlook and any other SMTP server also work. The password is encrypted with the macOS Keychain (click
   *Always Allow* if macOS asks) and is never shown in the UI or written in plain text.
2. **Recipients.** Use **Import CSV** (the file from *Export CSV*, or any spreadsheet with an Email column), **Paste emails**,
   or click **Email these N** on the Contacts page to add the professors currently shown. Duplicates and invalid addresses
   are dropped. Anyone you've already emailed is unticked, so nobody gets the same email twice.
3. **Message.** Write one template; placeholders are filled per professor:
   `{{lastName}}`, `{{name}}`, `{{firstName}}`, `{{iit}}`, `{{department}}`, `{{research}}` (their first two research areas).
   `{{research|your research}}` uses the text after `|` when a professor has no research areas listed.
   Attach your CV. The preview shows the exact email for whichever recipient you click.
4. **Send.** *Send test to me* first, then **Send to N**. Emails go out one at a time (one recipient each, no CC/BCC),
   with a pause between them (30 s by default), which keeps your account out of spam filters. Sending stops automatically
   on a login error or when the provider's daily limit is hit (Gmail: about 500 a day; batches under 100 are safer).

Sending is blocked while the message still contains `[Your Name]`-style brackets from the template, or an unknown placeholder.
A log of sent emails is kept in the app's data folder (`sent-log.json`).

## Command-line scraper

Useful for checking data quality without the UI. Prints JSON to stdout and progress to stderr.

```bash
npm run scrape -- Mumbai              # all tech departments at IIT Bombay
npm run scrape -- Mumbai cse          # one department
npm run scrape -- Delhi --summary     # counts per department
npm run scrape -- Kanpur --refresh    # ignore the cache
npx electron scripts/scrape.js Indore # departments marked "render" need a browser (or: npm i puppeteer)
npm test                              # unit tests (email de-obfuscation, mail merge, SMTP sending against a local fake server)
```

## How it works

```
data/iits.json        city/alias → IIT → list of department sources (all 23 IITs)
scrapers/
  index.js            resolves a city, runs each department's scraper, merges duplicates, caches
  utils.js            polite fetch (1 req/sec/host, robots.txt, retries), email de-obfuscation,
                      record builder, text helpers
  generic.js          config-driven scrapers used by most sites:
                        cards      – repeated HTML "cards"/table rows on a listing page
                        json-api   – a JSON endpoint the site's own page calls
                        js-bundle  – data baked into a single-page app's JS bundle (parsed with acorn)
                        next-data  – data embedded in a Next.js page
  iitb.js, iitk.js    site-specific scrapers (IIT Bombay CSE API, IIT Kanpur directory with "Load more")
  enrich.js           opens individual profile pages to fill in missing email/research/Scholar/homepage
  render.js           loads JavaScript-only or browser-only pages in a hidden browser window
  cache.js            JSON cache, one file per IIT, with timestamps
mail/
  recipients.js       CSV / pasted-text import, email column detection, de-duplication
  template.js         {{placeholder}} mail merge with fallbacks
  sender.js           SMTP sending (nodemailer): one email at a time, delays, sent log
electron/main.js      main process: scraping, IPC, CSV save dialog, opening links
electron/mail-ipc.js  main-process side of "Email them" (settings, keychain, sending)
electron/preload.js   the small API the UI is allowed to call
src/                  React UI (App.jsx sidebar shell, Contacts.jsx, EmailView.jsx)
```

Every scraper returns the same record:

```js
{ name, iit, department, researchAreas, email, homepage, scholar, profileUrl, linkedinSearchUrl }
```

**Emails.** Pages write emails in many ways: `prof [at] cse.iitb.ac.in`, `prof (at) iitd (dot) ac (dot) in`, `prof AT cse DOT iitm DOT ac DOT in`, `rajivm[*AT]iitp.ac.in`, HTML entities, Joomla's JavaScript "email cloaking"… `deobfuscateEmail()` normalizes these, and only addresses that validate are kept. Office mailboxes (`hod@`, `office@`…) are skipped in favour of the professor's own address. Emails are never guessed: if a site doesn't publish one, the field is left blank.

**LinkedIn.** LinkedIn is never scraped. The app only builds a people-search link: `https://www.linkedin.com/search/results/people/?keywords=<Name>%20<IIT>`.

**Politeness.** At most 1 request per second per website, robots.txt is respected, and requests identify themselves as `IITProfessorFinder/1.0`. That makes a first search slow (a minute or two when profile pages have to be opened), so results are cached for a week. Use **Refresh** to scrape again.

**Failures.** If one department fails, the others still show, with a warning listing what went wrong. If a live scrape returns nothing, the last cached result is shown instead. A refresh never loses data: if a value can't be fetched this time, the previously cached value for that professor is kept. If a site starts answering with a CAPTCHA (IIT Madras CSE does this after many requests), the scraper stops requesting that site and shows a warning. Wait a while before refreshing again.

**Where the cache lives.** In the app: the user-data folder (macOS: `~/Library/Application Support/iit-professor-finder/cache`). From the CLI: `./cache`.

## Coverage and known limitations

| IIT | Departments | Notes |
|---|---|---|
| Bombay | CSE, EE, C-MInDS (AI/DS centre) | C-MInDS members get emails from their home department |
| Delhi | CSE, EE, Yardi School of AI | |
| Madras | CSE, EE, Wadhwani School of DS & AI | WSAI pages only show the school office email |
| Kanpur | CSE, EE, Intelligent Systems / WSAIS, Statistics & DS | official emails from the institute directory |
| Jammu | CSE, EE | institute's JSON API |
| Roorkee | CSE, EE | |
| Guwahati | CSE, EEE | |
| Hyderabad | CSE, EE | |
| Indore | CSE | needs the hidden-browser renderer |
| BHU Varanasi | CSE, EE, ECE | |
| ISM Dhanbad | CSE, EE, ECE | institute-wide list |
| Ropar | CSE | research areas often empty in the source |
| Bhubaneswar | School of Electrical & Computer Sciences | |
| Patna | CSE, EE | |
| Mandi | School of Computing & EE | no research areas published |
| Tirupati | CSE, EE | |
| Palakkad | CSE, EE | **no emails published by the institute** |
| Dharwad | CSE, EECE | no research areas published |
| Goa | CSE, EE | |
| **Kharagpur** | – | not scraped (JavaScript-only, frequent timeouts) |
| **Gandhinagar** | – | not scraped (Cloudflare bot challenge) |
| **Jodhpur** | – | not scraped (bot protection) |
| **Bhilai** | – | not scraped (no machine-readable list) |

For the four unscraped IITs the app shows the faculty-page link to open in a browser. University websites change often. When a department suddenly returns nothing, the app warns *"page loaded but no professors were found (layout may have changed)"*. The fix is usually a selector in `data/iits.json`.

## Adding or fixing a department

Most departments are pure configuration. For a page with repeated cards:

```json
{
  "id": "cse",
  "name": "Computer Science & Engineering",
  "scraper": "cards",
  "url": "https://example.iitx.ac.in/faculty",
  "card": ".faculty-card",
  "nameSel": "h3",
  "research": ".interests",
  "profiles": "missing"
}
```

The full list of options is documented at the top of `scrapers/generic.js`. Test a change with `npm run scrape -- <City> <deptId> --refresh`.
# IIT
