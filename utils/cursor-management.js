import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CURSOR_PATH = join(__dirname, '../cursors');

/**
 * Save a pagination cursor for an account
 * @param {string} accountId - Account identifier
 * @param {string} cursor - GraphQL pagination cursor
 * @returns {Promise<void>}
 */
export async function saveCursor(accountId, cursor) {
  try {
    await mkdir(CURSOR_PATH, { recursive: true });

    const cursorFile = join(CURSOR_PATH, `${accountId}.json`);
    await writeFile(cursorFile, JSON.stringify({
      cursor,
      timestamp: new Date().toISOString()
    }));
    console.log(`Saved cursor for account ${accountId}`);
  } catch (error) {
    console.error(`Error saving cursor for account ${accountId}:`, error);
    throw error;
  }
}

/**
 * Load a pagination cursor for an account
 * @param {string} accountId - Account identifier
 * @returns {Promise<string|null>} Cursor string or null if not found
 */
export async function loadCursor(accountId) {
  try {
    const cursorFile = join(CURSOR_PATH, `${accountId}.json`);
    const data = await readFile(cursorFile, 'utf-8');
    const { cursor } = JSON.parse(data);
    console.log(`Loaded cursor for account ${accountId}`);
    return cursor;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // No cursor file exists yet
      console.log(`No cursor file found for account ${accountId}`);
      return null;
    }
    console.error(`Error loading cursor for account ${accountId}:`, error);
    throw error;
  }
}