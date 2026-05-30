# rss2md

Parse an RSS feed and write each feed item as a Markdown file.

The CLI is an ESM TypeScript application that uses:

- [`feedsmith`](https://feedsmith.dev/) for RSS parsing
- Node's built-in `node:sqlite` module for item state tracking

## Requirements

- Node.js `>=22.5`
- npm

## Install dependencies

```sh
npm install
```

## Build

```sh
npm run build
```

This creates the executable CLI at `dist/rss2md`.

## Usage

```sh
./dist/rss2md <feed-url> [options]
```

Example:

```sh
./dist/rss2md https://example.com/@user --output ./out
```

Run through TypeScript during development:

```sh
npm run dev -- https://example.com/@user --output ./out
```

## CLI flags

| Flag | Default | Description |
| --- | --- | --- |
| `<feed-url>` | Required | RSS feed URL to fetch and convert. |
| `-o, --output <dir>` | `out` | Directory where Markdown files are written. |
| `--db <path>` | `<output>/rss2md.db` | SQLite database used to remember processed feed items. |
| `--limit <n>` | No limit | Process only the first `n` feed items. Must be a positive integer. |
| `--force` | `false` | Rewrite items even if they already exist in the SQLite state database. |
| `--version` | n/a | Print the CLI version from `package.json`. |
| `-h, --help` | n/a | Print CLI help. |

## Output

Each RSS item is written as a Markdown file named with the item date, an 8-character feed URL hash, and the item ID, for example:

```text
out/2026-05-29-85ee847c-116658518702934128.md
```

Markdown files include YAML front matter:

```md
---
title: "Example title"
date: 2026-05-29T15:15:29Z
source: "https://example.com/post"
guid: "https://example.com/post"
feed: "Feed title"
tags:
  - example
---

Item body converted from RSS HTML to Markdown.
```

## State tracking

By default, rss2md writes a SQLite database to:

```text
<output>/rss2md.db
```

The database records processed items so repeated runs can skip unchanged output.

## Idempotency behavior

rss2md identifies each item by:

1. RSS item GUID
2. RSS item link, if GUID is missing
3. a SHA-256 hash of title, publish date, and body, if both GUID and link are missing

State is keyed by both `feed_url` and item ID. This allows multiple feeds to share the same output directory and database without item ID collisions. Filenames also include a short hash of the feed URL to reduce cross-feed filename collisions.

For each run, rss2md renders the Markdown first and computes a content hash from the rendered Markdown. It skips an item only when all of these are true:

- `--force` is not set
- the same `feed_url` and item ID already exist in SQLite
- the stored content hash matches the newly rendered Markdown
- the expected Markdown file still exists at the stored path

rss2md writes or rewrites the Markdown file when an item is new, its rendered content changed, its expected path changed, the output file is missing, or `--force` is used.

## Validation

```sh
npm run lint
npm run build
./dist/rss2md --version
./dist/rss2md https://example.com/@user --output ./out
```
