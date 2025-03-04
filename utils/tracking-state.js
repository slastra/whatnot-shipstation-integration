import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATE_PATH = join(__dirname, '../tracking_state');

/**
 * Save tracking update state for an account
 * @param {string} storeId - ShipStation store ID
 * @param {Object} state - State object to save
 * @returns {Promise<void>}
 */
export async function saveTrackingState(storeId, state) {
  try {
    await mkdir(STATE_PATH, { recursive: true });

    const stateFile = join(STATE_PATH, `shipstation_${storeId}.json`);
    await writeFile(stateFile, JSON.stringify({
      ...state,
      updatedAt: new Date().toISOString()
    }));
    console.log(`Saved tracking state for store ${storeId}`);
  } catch (error) {
    console.error(`Error saving tracking state for store ${storeId}:`, error);
    throw error;
  }
}

/**
 * Load tracking update state for an account
 * @param {string} storeId - ShipStation store ID
 * @returns {Promise<Object|null>} State object or null if not found
 */
export async function loadTrackingState(storeId) {
  try {
    const stateFile = join(STATE_PATH, `shipstation_${storeId}.json`);
    const data = await readFile(stateFile, 'utf-8');
    const state = JSON.parse(data);
    console.log(`Loaded tracking state for store ${storeId}`);
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // No state file exists yet
      console.log(`No tracking state found for store ${storeId}`);
      return null;
    }
    console.error(`Error loading tracking state for store ${storeId}:`, error);
    throw error;
  }
}