import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { argv, cwd, exit } from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { parseRssFeed } from 'feedsmith';
import type { DeepPartial, Rss } from 'feedsmith/types';

declare const __VERSION__: string;

const version = __VERSION__;
const defaultUserAgent = `rss2md/${version}`;
const defaultOutputDir = 'out';

type RssItem = DeepPartial<Rss.Item<string>>;

interface Options {
  feedUrl: string;
  outputDir: string;
  databasePath: string;
  limit: number | undefined;
  force: boolean;
}

interface MarkdownItem {
  id: string;
  title: string;
  sourceUrl: string;
  publishedAt: string;
  categories: string[];
  filename: string;
  markdown: string;
  contentHash: string;
}

interface ItemState {
  contentHash: string;
  markdownPath: string;
}

function itemsTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS items (
  feed_url TEXT NOT NULL,
  id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  markdown_path TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (feed_url, id)
);`;
}

class Store {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    this.#init();
  }

  close(): void {
    this.#db.close();
  }

  itemState(feedUrl: string, id: string): ItemState | undefined {
    return this.#db
      .prepare(
        `SELECT content_hash AS contentHash, markdown_path AS markdownPath FROM items WHERE feed_url = ? AND id = ?`
      )
      .get(feedUrl, id) as ItemState | undefined;
  }

  recordItem(feedUrl: string, item: MarkdownItem, markdownPath: string): void {
    this.#db
      .prepare(
        `INSERT INTO items
           (feed_url, id, source_url, title, published_at, content_hash, markdown_path, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(feed_url, id) DO UPDATE SET
           source_url = excluded.source_url,
           title = excluded.title,
           published_at = excluded.published_at,
           content_hash = excluded.content_hash,
           markdown_path = excluded.markdown_path,
           imported_at = excluded.imported_at`
      )
      .run(
        feedUrl,
        item.id,
        item.sourceUrl,
        item.title,
        item.publishedAt,
        item.contentHash,
        markdownPath,
        new Date().toISOString()
      );
  }

  #init(): void {
    const table = this.#db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'`)
      .get() as { name: string } | undefined;

    if (table === undefined) {
      this.#db.exec(itemsTableSql());
      return;
    }

    const columns = this.#db.prepare(`PRAGMA table_info(items)`).all() as Array<{
      name: string;
      pk: number;
    }>;
    const columnNames = new Set(columns.map(column => column.name));
    const primaryKey = columns
      .filter(column => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map(column => column.name);

    if (
      columnNames.has('feed_url') &&
      columnNames.has('content_hash') &&
      primaryKey.join(',') === 'feed_url,id'
    ) {
      return;
    }

    this.#db.exec(`
BEGIN;
DROP TABLE IF EXISTS items_legacy;
ALTER TABLE items RENAME TO items_legacy;
${itemsTableSql()}
INSERT OR IGNORE INTO items
  (feed_url, id, source_url, title, published_at, content_hash, markdown_path, imported_at)
SELECT
  '', id, source_url, title, published_at, '', markdown_path, imported_at
FROM items_legacy;
DROP TABLE items_legacy;
COMMIT;
`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(argv.slice(2));
  mkdirSync(options.outputDir, { recursive: true });

  const xml = await fetchFeed(options.feedUrl);
  const feed = parseRssFeed(xml);
  const feedTitle = feed.title ?? '';
  const items =
    options.limit === undefined ? (feed.items ?? []) : (feed.items ?? []).slice(0, options.limit);
  const store = new Store(options.databasePath);

  let written = 0;
  let skipped = 0;

  try {
    for (const item of items) {
      const markdownItem = toMarkdownItem(options.feedUrl, feedTitle, item);
      const markdownPath = join(options.outputDir, markdownItem.filename);
      const state = store.itemState(options.feedUrl, markdownItem.id);

      if (
        !options.force &&
        state?.contentHash === markdownItem.contentHash &&
        state.markdownPath === markdownPath &&
        existsSync(markdownPath)
      ) {
        skipped += 1;
        continue;
      }

      await writeFile(markdownPath, markdownItem.markdown, 'utf8');
      store.recordItem(options.feedUrl, markdownItem, markdownPath);
      written += 1;
    }
  } finally {
    store.close();
  }

  console.log(`Feed: ${feedTitle}`);
  console.log(`Items: ${items.length.toString()}`);
  console.log(`Written: ${written.toString()}`);
  console.log(`Skipped: ${skipped.toString()}`);
  console.log(`Output: ${options.outputDir}`);
  console.log(`State: ${options.databasePath}`);
}

async function fetchFeed(feedUrl: string): Promise<string> {
  const response = await fetch(feedUrl, {
    headers: {
      accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1',
      'user-agent': defaultUserAgent,
    },
  });

  if (!response.ok) {
    throw new Error(`failed to fetch feed: ${response.status.toString()} ${response.statusText}`);
  }

  return response.text();
}

function toMarkdownItem(feedUrl: string, feedTitle: string, item: RssItem): MarkdownItem {
  const sourceUrl = item.link ?? item.guid?.value ?? '';
  const bodyHtml = item.content?.encoded ?? item.description ?? '';
  const body = htmlToMarkdown(bodyHtml).trim();
  const title = item.title?.trim() || titleFromBody(body) || sourceUrl || 'Untitled item';
  const publishedAt = isoDate(item.pubDate);
  const id = item.guid?.value ?? (sourceUrl || hash(`${title}\n${publishedAt}\n${body}`));
  const categories =
    item.categories
      ?.map(category => category.name ?? '')
      .filter((category): category is string => category !== '') ?? [];
  const filename = markdownFilename(publishedAt, feedUrl, id, title);
  const markdown = renderMarkdown({
    body,
    categories,
    feedTitle,
    id,
    publishedAt,
    sourceUrl,
    title,
  });

  return {
    id,
    title,
    sourceUrl,
    publishedAt,
    categories,
    filename,
    markdown,
    contentHash: hash(markdown),
  };
}

function renderMarkdown(input: {
  body: string;
  categories: string[];
  feedTitle: string;
  id: string;
  publishedAt: string;
  sourceUrl: string;
  title: string;
}): string {
  const lines = [
    '---',
    `title: ${yamlString(input.title)}`,
    `date: ${input.publishedAt}`,
    `source: ${yamlString(input.sourceUrl)}`,
    `guid: ${yamlString(input.id)}`,
    `feed: ${yamlString(input.feedTitle)}`,
  ];

  if (input.categories.length > 0) {
    lines.push('categories:');
    for (const category of input.categories) {
      lines.push(`  - ${yamlString(category)}`);
    }
  }

  lines.push('---', '', input.body, '');
  return lines.join('\n');
}

function htmlToMarkdown(html: string): string {
  let text = decodeHtmlEntities(html);

  text = text.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href, label) => {
      const cleanedLabel = stripTags(decodeHtmlEntities(label)).trim() || href;
      return `[${escapeMarkdownLinkText(cleanedLabel)}](${href})`;
    }
  );

  text = text
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>\s*<p\b[^>]*>/gi, '\n\n')
    .replace(/<\/?p\b[^>]*>/gi, '')
    .replace(/<\/h[1-6]>\s*/gi, '\n\n')
    .replace(/<h([1-6])\b[^>]*>/gi, (_match, level) => `${'#'.repeat(Number(level))} `)
    .replace(/<\/li>\s*/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/blockquote>\s*/gi, '\n\n')
    .replace(/<blockquote\b[^>]*>/gi, '> ');

  text = stripTags(text);
  return decodeHtmlEntities(text)
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[\\[\]]/g, match => `\\${match}`);
}

function titleFromBody(body: string): string {
  const firstLine = body
    .split('\n')
    .map(line => line.trim())
    .find(Boolean);

  if (firstLine === undefined) {
    return '';
  }

  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function markdownFilename(publishedAt: string, feedUrl: string, id: string, title: string): string {
  const datePrefix = publishedAt === '' ? 'undated' : publishedAt.slice(0, 10);
  const feedPart = hash(feedUrl).slice(0, 8);
  const idPart = slugify(lastUrlPathSegment(id) || id).slice(0, 48);
  const titlePart = slugify(title).slice(0, 48);
  const slug = idPart || titlePart || hash(id).slice(0, 12);
  return `${datePrefix}-${feedPart}-${slug}.md`;
}

function lastUrlPathSegment(value: string): string {
  try {
    const url = new URL(value);
    const segment = url.pathname.split('/').filter(Boolean).at(-1);
    return segment ?? '';
  } catch {
    return '';
  }
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isoDate(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    return '';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(args: string[]): Options {
  let outputDir = defaultOutputDir;
  let databasePath: string | undefined;
  let limit: number | undefined;
  let force = false;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      throw new Error('missing argument');
    }

    if (arg === '--force') {
      force = true;
    } else if (arg === '--output' || arg === '-o') {
      outputDir = requiredValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith('--output=')) {
      outputDir = arg.slice('--output='.length);
    } else if (arg === '--db') {
      databasePath = requiredValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith('--db=')) {
      databasePath = arg.slice('--db='.length);
    } else if (arg === '--limit') {
      limit = positiveInteger(requiredValue(args, index, arg), arg);
      index += 1;
    } else if (arg.startsWith('--limit=')) {
      limit = positiveInteger(arg.slice('--limit='.length), '--limit');
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    throw new Error('expected exactly one RSS feed URL');
  }

  outputDir = resolvePath(outputDir);
  databasePath = resolvePath(databasePath ?? join(outputDir, 'rss2md.db'));

  const feedUrl = positional[0];
  if (feedUrl === undefined) {
    throw new Error('expected exactly one RSS feed URL');
  }

  return {
    feedUrl,
    outputDir,
    databasePath,
    limit,
    force,
  };
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function positiveInteger(value: string, option: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return number;
}

function resolvePath(path: string): string {
  if (path === '~') {
    return homedir();
  }

  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }

  return resolve(cwd(), path);
}

function usage(): string {
  return `Usage: rss2md <feed-url> [options]

Options:
  -o, --output <dir>  Directory for markdown files (default: ${defaultOutputDir})
      --db <path>     SQLite state database (default: <output>/rss2md.db)
      --limit <n>     Only process the first n feed items
      --force         Rewrite items already recorded in the database
      --version       Print version
  -h, --help          Print help`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (argv.includes('--version')) {
  console.log(version);
  exit(0);
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(usage());
  exit(0);
}

main().catch((error: unknown) => {
  console.error('ERROR:', errorMessage(error));
  exit(1);
});
