import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_LOOKBACK_DAYS = 2;
const SYNC_PATH = join(__dirname, '../sync_times');

/**
 * Save the last sync time for a store
 * @param {string|number} storeId - The ID of the store
 * @param {string} lastSyncTime - ISO timestamp of the last sync time
 */
export async function saveSyncTime(storeId, lastSyncTime) {
  try {
    await mkdir(SYNC_PATH, { recursive: true });
    const syncFile = join(SYNC_PATH, `shipstation_${storeId}.json`);
    await writeFile(syncFile, JSON.stringify({
      lastSyncTime,
      timestamp: new Date().toISOString()
    }));
    console.log(`Saved sync time for store ${storeId}: ${lastSyncTime}`);
  } catch (error) {
    console.error(`Error saving sync time for store ${storeId}:`, error);
    throw error;
  }
}

/**
 * Load the last sync time for a store, or return a default if none exists
 * @param {string|number} storeId - The ID of the store
 * @param {number} [lookbackDays=DEFAULT_LOOKBACK_DAYS] - Number of days to look back if no sync time found
 * @returns {string} ISO timestamp to use as the start time for syncing
 */
export async function loadSyncTime(storeId, lookbackDays = DEFAULT_LOOKBACK_DAYS) {
  try {
    const syncFile = join(SYNC_PATH, `shipstation_${storeId}.json`);
    const data = await readFile(syncFile, 'utf-8');
    const { lastSyncTime } = JSON.parse(data);
    console.log(`Loaded previous sync time for store ${storeId}: ${lastSyncTime}`);
    return lastSyncTime;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // No sync file exists yet
      const defaultStartDate = new Date();
      defaultStartDate.setDate(defaultStartDate.getDate() - lookbackDays);
      const startTime = defaultStartDate.toISOString();
      console.log(`No previous sync time found for store ${storeId}. Using default lookback: ${startTime}`);
      return startTime;
    }
    console.error(`Error loading sync time for store ${storeId}:`, error);
    throw error;
  }
}