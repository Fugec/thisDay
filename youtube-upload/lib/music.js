/**
 * Background music helper.
 *
 * HOW TO SET UP (one-time manual step):
 *   1. Open YouTube Studio → Audio Library
 *   2. Search for "From Russia with Love"
 *   3. Click the download icon to save it as an MP3
 *   4. Rename the file to "background.mp3" and place it at:
 *        youtube-upload/assets/background.mp3
 *
 * The pipeline mixes this track at 15% volume under the ElevenLabs narration.
 * If the file is absent the video is generated without background music.
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const ASSETS_DIR  = './assets';
const MUSIC_PATH  = join(ASSETS_DIR, 'background.mp3');

/**
 * Returns the path to the background music file, or null if not present.
 *
 * @returns {string|null}
 */
export function getMusicPath() {
  mkdirSync(ASSETS_DIR, { recursive: true });

  if (existsSync(MUSIC_PATH)) return MUSIC_PATH;

  console.log(
    '  ⚠ No background music found at assets/background.mp3\n' +
    '    Download "From Russia with Love" from YouTube Studio → Audio Library\n' +
    '    and save it as assets/background.mp3 to enable background music.',
  );
  return null;
}
