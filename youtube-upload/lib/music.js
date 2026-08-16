/**
 * Background music helper.
 *
 * The pipeline uses the supplied Lacrimosa track under the ElevenLabs
 * narration. The actual mix level is defined centrally in video.js.
 * If the file is absent the video is generated without background music.
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const ASSETS_DIR  = './assets';
const MUSIC_FILE  = 'lacrimosa thisday.mp3';
const MUSIC_PATH  = join(ASSETS_DIR, MUSIC_FILE);

/**
 * Returns the path to the background music file, or null if not present.
 *
 * @returns {string|null}
 */
export function getMusicPath() {
  mkdirSync(ASSETS_DIR, { recursive: true });

  if (existsSync(MUSIC_PATH)) return MUSIC_PATH;

  console.log(
    `  ⚠ No background music found at assets/${MUSIC_FILE}`,
  );
  return null;
}
